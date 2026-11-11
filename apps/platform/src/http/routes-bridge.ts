import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RunAssignment } from '@staff-agent/shared';
import {
  AckRequestSchema,
  EnrollPollRequestSchema,
  PollRequestSchema,
  RegisterRequestSchema,
  RunReportRequestSchema,
  StepsRequestSchema,
} from '@staff-agent/shared';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { findActiveDeviceByAgent, findDeviceByTokenHash, touchDevice, upsertDevice, type Device } from '../domain/devices.js';
import { createEnrollCode } from '../domain/enroll.js';
import { ackRun, finishRun, type Run, type RunRow } from '../domain/runs.js';
import { updateConversationSession } from '../domain/conversations.js';
import type { EnrollService } from '../services/enroll-service.js';
import type { Inbox } from '../services/inbox.js';
import type { RunNotifier } from '../services/run-notifier.js';
import { ingestSteps } from '../trace/ingest.js';
import { sha256 } from '../util/hash.js';
import { errorText, type Logger } from '../util/logger.js';

/** 网关路由依赖。 */
export interface BridgeRouteDeps {
  db: Db;
  config: Config;
  inbox: Inbox;
  enroll: EnrollService;
  notifier: RunNotifier;
  logger: Logger;
}

/** 认证失败响应。 */
function unauthorized(reply: FastifyReply, reason: string): void {
  void reply.code(401).send({ ok: false, error: reason, code: 'UNAUTHORIZED' });
}

/**
 * 从 Authorization: Bearer 中解析设备。
 * 数据库只存 SHA-256 哈希，令牌泄露时无法从库里还原。
 */
function authenticate(request: FastifyRequest, db: Db): Device | null {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  if (!token) return null;
  return findDeviceByTokenHash(db, sha256(token));
}

/** 把任务实体转成网关可执行的任务包。 */
function toAssignment(run: Run, config: Config): RunAssignment {
  return {
    runId: run.id,
    leaseId: run.leaseId as string,
    conversationId: run.conversationId,
    sessionRef: run.sessionRef,
    prompt: run.prompt,
    cwd: null,
    timeoutSec: config.AGENT_TIMEOUT_SEC,
    createdAt: run.createdAt,
  };
}

/**
 * 网关协议路由：register → enroll/poll → poll → ack → steps → report。
 * 全部是网关主动外连，平台不需要访问员工机器。
 */
export function registerBridgeRoutes(app: FastifyInstance, deps: BridgeRouteDeps): void {
  const { db, config, inbox, enroll, notifier, logger } = deps;

  // 注册设备并生成绑定码（无需认证：此时还没有令牌）
  app.post('/api/bridge/register', async (request, reply) => {
    const parsed = RegisterRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.issues.map((i) => i.message).join('; ') });
    }
    const device = upsertDevice(db, parsed.data);
    const { code, expiresAt } = createEnrollCode(db, {
      deviceId: device.id,
      ttlSec: config.ENROLL_TTL_SEC,
      pepper: config.sessionSecret,
    });
    logger.info({ deviceId: device.id, machineName: device.machineName, runtime: device.runtime }, '设备注册');
    return {
      code,
      expiresAt,
      pollIntervalMs: 2_000,
      bindUrl: config.PUBLIC_BASE_URL ? `${config.PUBLIC_BASE_URL.replace(/\/$/, '')}/bind/${code}` : null,
    };
  });

  // 轮询绑定结果，绑定时一次性下发令牌
  app.post('/api/bridge/enroll/poll', async (request, reply) => {
    const parsed = EnrollPollRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: '绑定码格式错误' });
    }
    return enroll.poll(parsed.data.code);
  });

  // 长轮询接任务
  app.post('/api/bridge/poll', async (request, reply) => {
    const device = authenticate(request, db);
    if (!device) return unauthorized(reply, '设备令牌无效');
    if (!device.agentId) return unauthorized(reply, '设备尚未绑定 Agent，请先完成绑定');

    const parsed = PollRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: '心跳参数格式错误' });
    }
    const agent = findActiveDeviceByAgent(db, device.agentId);
    if (!agent || agent.id !== device.id) {
      return unauthorized(reply, '该设备已被替换或撤销，请重新登录');
    }

    touchDevice(db, device.id, {
      bridgeState: parsed.data.state,
      runtimeVersion: parsed.data.runtimeVersion ?? null,
      bridgeVersion: parsed.data.bridgeVersion ?? null,
    });

    const run = await inbox.claim({
      agentId: device.agentId,
      deviceId: device.id,
      leaseMs: config.RUN_LEASE_MS,
      holdMs: config.POLL_HOLD_MS,
    });
    return {
      run: run ? toAssignment(run, config) : null,
      serverTime: new Date().toISOString(),
    };
  });

  // 认领确认，刷新租约
  app.post('/api/bridge/runs/:runId/ack', async (request, reply) => {
    const device = authenticate(request, db);
    if (!device) return unauthorized(reply, '设备令牌无效');
    const params = request.params as { runId: string };
    const parsed = AckRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: '参数格式错误' });
    const ok = ackRun(db, {
      runId: params.runId,
      deviceId: device.id,
      leaseId: parsed.data.leaseId,
      leaseMs: config.RUN_LEASE_MS,
    });
    if (!ok) return reply.code(409).send({ ok: false, error: '租约已失效', code: 'LEASE_LOST' });
    return { ok: true };
  });

  // 批量上报 trace 步骤（幂等，可重传）
  app.post('/api/bridge/runs/:runId/steps', async (request, reply) => {
    const device = authenticate(request, db);
    if (!device) return unauthorized(reply, '设备令牌无效');
    const params = request.params as { runId: string };
    const parsed = StepsRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.issues.map((i) => i.message).join('; ') });
    }
    const run = db.prepare('SELECT * FROM runs WHERE id = ? AND device_id = ?').get(params.runId, device.id) as
      | RunRow
      | undefined;
    if (!run) return reply.code(404).send({ ok: false, error: '任务不存在' });
    if (run.status !== 'running') {
      return reply.code(409).send({ ok: false, error: '任务已结束', code: 'RUN_CLOSED' });
    }
    const accepted = ingestSteps(db, run.id, parsed.data.steps, config.TRACE_MAX_SUMMARY_CHARS);
    return { ok: true, accepted };
  });

  // 任务终态上报，同时回传结果到飞书
  app.post('/api/bridge/runs/:runId/report', async (request, reply) => {
    const device = authenticate(request, db);
    if (!device) return unauthorized(reply, '设备令牌无效');
    const params = request.params as { runId: string };
    const parsed = RunReportRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.issues.map((i) => i.message).join('; ') });
    }
    const updated = finishRun(db, {
      runId: params.runId,
      deviceId: device.id,
      leaseId: parsed.data.leaseId,
      status: parsed.data.status,
      result: parsed.data.result ?? null,
      error: parsed.data.error ?? null,
      durationMs: parsed.data.durationMs ?? null,
      inputTokens: parsed.data.inputTokens ?? 0,
      outputTokens: parsed.data.outputTokens ?? 0,
      sessionRef: parsed.data.sessionRef ?? null,
    });
    if (!updated) {
      return reply.code(409).send({ ok: false, error: '租约已失效或任务已结束', code: 'LEASE_LOST' });
    }
    if (parsed.data.sessionRef) {
      updateConversationSession(db, updated.conversation_id, parsed.data.sessionRef);
    }
    notifier.notifyFinished(updated.id).catch((error: unknown) => {
      logger.error({ err: errorText(error), runId: updated.id }, '任务结果通知失败');
    });
    return { ok: true };
  });
}
