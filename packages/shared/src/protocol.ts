import { z } from 'zod';
import {
  AgentRuntimeSchema,
  AgentStatusSchema,
  BridgeStateSchema,
  EnrollStateSchema,
  RunStatusSchema,
  StepTypeSchema,
} from './enums.js';
import type { AgentRuntime, AgentStatus, BridgeState, RunStatus, StepType } from './enums.js';

/** 绑定码长度（纯数字），员工在飞书里发给机器人即可完成绑定。 */
export const ENROLL_CODE_LENGTH = 6;

/** 长轮询服务端最长挂起时间（毫秒）。 */
export const POLL_HOLD_MS = 25_000;

/** 任务租约时长（毫秒）。超时未上报视为 Agent 掉线，任务重新排队。 */
export const RUN_LEASE_MS = 120_000;

/**
 * 本地网关注册请求：员工首次运行 `sa login` 时发出。
 * 只登记设备与运行时，尚未绑定飞书身份，返回的绑定码由员工发到飞书完成绑定。
 */
export const RegisterRequestSchema = z.object({
  /** 设备稳定标识（hostname + 用户名的哈希），用于同一台机器重复注册时复用设备记录 */
  machineId: z.string().min(8).max(128),
  /** 便于管理员识别的机器名 */
  machineName: z.string().min(1).max(128),
  /** 员工选择的运行时 */
  runtime: AgentRuntimeSchema,
  /** 运行时版本，例如 pi 1.5.2 */
  runtimeVersion: z.string().max(64).optional(),
  /** 网关版本 */
  bridgeVersion: z.string().max(64).optional(),
});
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;

/** 注册响应：返回绑定码与过期时间，网关开始轮询绑定结果。 */
export const RegisterResponseSchema = z.object({
  /** 6 位绑定码 */
  code: z.string().length(ENROLL_CODE_LENGTH),
  /** 过期时间（ISO 8601） */
  expiresAt: z.string(),
  /** 建议轮询间隔（毫秒） */
  pollIntervalMs: z.number().int().positive(),
  /** 可选的二维码内容；未配置公网地址时为空 */
  bindUrl: z.string().nullable(),
});
export type RegisterResponse = z.infer<typeof RegisterResponseSchema>;

/** 绑定结果轮询请求。 */
export const EnrollPollRequestSchema = z.object({
  code: z.string().length(ENROLL_CODE_LENGTH),
});
export type EnrollPollRequest = z.infer<typeof EnrollPollRequestSchema>;

/** 绑定结果轮询响应。 */
export const EnrollPollResponseSchema = z.object({
  state: EnrollStateSchema,
  /** 绑定成功后下发的一次性设备令牌，只在本次响应中出现 */
  deviceToken: z.string().nullable(),
  agentId: z.string().nullable(),
  agentName: z.string().nullable(),
});
export type EnrollPollResponse = z.infer<typeof EnrollPollResponseSchema>;

/** 长轮询请求：携带运行时状态，平台据此判断在线与忙闲。 */
export const PollRequestSchema = z.object({
  state: BridgeStateSchema,
  activeRuns: z.number().int().min(0).max(64),
  runtimeVersion: z.string().max(64).optional(),
  bridgeVersion: z.string().max(64).optional(),
  /** 主工作区目录（本机绝对路径）；变了平台才会更新，用于后台展示 */
  cwd: z.string().max(512).optional(),
  /** 主工作区职责说明，跟着 cwd 一起上报 */
  description: z.string().max(500).nullable().optional(),
});
export type PollRequest = z.infer<typeof PollRequestSchema>;

/** 一个待执行任务。租约在 poll 时生成，ack/report/steps 都必须带。 */
export const RunAssignmentSchema = z.object({
  runId: z.string(),
  leaseId: z.string(),
  /** 执行本任务的 Agent（同一台机器可能有多个 Agent） */
  agentId: z.string().optional(),
  agentName: z.string().optional(),
  /** 飞书会话标识，用于把多轮消息串成同一段上下文 */
  conversationId: z.string(),
  /** 传给运行时的续聊标识（pi session id / claude session id / codex thread id） */
  sessionRef: z.string().nullable(),
  /** 任务正文 */
  prompt: z.string(),
  /** 工作目录；为空时使用网关配置的默认目录 */
  cwd: z.string().nullable(),
  /** 单次任务超时（秒） */
  timeoutSec: z.number().int().positive(),
  /** 任务创建时间（ISO 8601） */
  createdAt: z.string(),
});
export type RunAssignment = z.infer<typeof RunAssignmentSchema>;

/** 长轮询响应。没有任务时 run 为 null。 */
export const PollResponseSchema = z.object({
  run: RunAssignmentSchema.nullable(),
  serverTime: z.string(),
});
export type PollResponse = z.infer<typeof PollResponseSchema>;

/** 认领任务：网关闭环确认已收到任务，平台把状态推进到 running。 */
export const AckRequestSchema = z.object({
  leaseId: z.string(),
});
export type AckRequest = z.infer<typeof AckRequestSchema>;

/** 单条 trace 步骤。seq 在同一任务内单调递增，用于幂等去重。 */
export const StepInputSchema = z.object({
  seq: z.number().int().min(0),
  type: StepTypeSchema,
  name: z.string().max(256),
  inputSummary: z.string().max(8000).optional(),
  outputSummary: z.string().max(8000).optional(),
  durationMs: z.number().int().min(0).optional(),
  inputTokens: z.number().int().min(0).optional(),
  outputTokens: z.number().int().min(0).optional(),
  isError: z.boolean().optional(),
  occurredAt: z.string().optional(),
});
export type StepInput = z.infer<typeof StepInputSchema>;

/** 批量上报步骤。 */
export const StepsRequestSchema = z.object({
  leaseId: z.string(),
  steps: z.array(StepInputSchema).min(1).max(200),
});
export type StepsRequest = z.infer<typeof StepsRequestSchema>;

/** 任务结束状态：只允许终态，避免网关把任务改回运行中。 */
export const RunFinalStatusSchema = z.enum(['succeeded', 'failed', 'canceled', 'timeout']);
export type RunFinalStatus = z.infer<typeof RunFinalStatusSchema>;

/** 任务结束上报。 */
export const RunReportRequestSchema = z.object({
  leaseId: z.string(),
  status: RunFinalStatusSchema,
  /** 面向飞书的最终回复 */
  result: z.string().max(60_000).optional(),
  error: z.string().max(4000).optional(),
  durationMs: z.number().int().min(0).optional(),
  inputTokens: z.number().int().min(0).optional(),
  outputTokens: z.number().int().min(0).optional(),
  /** 运行时返回的会话标识，下轮任务续聊使用 */
  sessionRef: z.string().max(256).nullable().optional(),
  /** 实际执行目录：工作区路由在本地决定，平台只做记录与展示 */
  cwd: z.string().max(512).nullable().optional(),
});
export type RunReportRequest = z.infer<typeof RunReportRequestSchema>;

/** 统一成功响应。 */
export const OkResponseSchema = z.object({ ok: z.literal(true) });
export type OkResponse = z.infer<typeof OkResponseSchema>;

/** 统一错误响应。 */
export const ErrorResponseSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
  code: z.string().optional(),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

/** 管理后台：Agent 摘要视图。 */
export interface AgentView {
  id: string;
  name: string;
  feishuOpenId: string;
  /** 飞书姓名（绑定时同步；无通讯录权限时为空） */
  feishuName: string | null;
  /** 飞书头像 URL（绑定时同步；无权限时为空） */
  feishuAvatarUrl: string | null;
  runtime: AgentRuntime;
  status: AgentStatus;
  /** 恒为 true：平台侧只存在主 Agent（数字员工），子工作区只在本机 */
  isPrimary: boolean;
  /** 工作目录（员工机器上的绝对路径） */
  cwd: string | null;
  /** 工作区说明 */
  description: string | null;
  createdAt: string;
  device: {
    id: string;
    machineName: string;
    runtimeVersion: string | null;
    lastSeenAt: string | null;
    online: boolean;
    bridgeState: BridgeState | null;
  } | null;
  runs7d: number;
  success7d: number;
}

/** 管理后台：任务摘要视图。 */
export interface RunView {
  id: string;
  agentId: string;
  agentName: string;
  status: RunStatus;
  promptPreview: string;
  /** 本次任务实际执行的工作目录（主工作区或某个子工作区） */
  cwd: string | null;
  createdAt: string;
  endedAt: string | null;
  durationMs: number | null;
  inputTokens: number;
  outputTokens: number;
  error: string | null;
}

/** 管理后台：任务详情（含步骤）。 */
export interface RunDetail extends RunView {
  prompt: string;
  result: string | null;
  steps: Array<{
    seq: number;
    type: StepType;
    name: string;
    inputSummary: string | null;
    outputSummary: string | null;
    durationMs: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    isError: boolean;
    createdAt: string;
  }>;
}

/** 管理后台：统计视图。 */
export interface StatsView {
  rangeDays: number;
  totals: {
    agents: number;
    agentsOnline: number;
    runs: number;
    succeeded: number;
    failed: number;
    successRate: number;
    avgDurationMs: number;
    inputTokens: number;
    outputTokens: number;
  };
  daily: Array<{
    date: string;
    runs: number;
    succeeded: number;
    failed: number;
    avgDurationMs: number;
    inputTokens: number;
    outputTokens: number;
  }>;
  topAgents: Array<{ agentId: string; name: string; runs: number; successRate: number }>;
  toolTop: Array<{ name: string; count: number; avgDurationMs: number; errorRate: number }>;
  runtimeSplit: Array<{ runtime: AgentRuntime; agents: number }>;
}
