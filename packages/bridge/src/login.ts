import { existsSync } from 'node:fs';
import qrcode from 'qrcode-terminal';
import type { AgentRuntime } from '@staff-agent/shared';
import { PlatformApi } from './api.js';
import { readConfig, writeConfig } from './config.js';
import { log, errorText, machineId, machineName } from './log.js';
import { createAdapter } from './runtimes/index.js';
import { BRIDGE_VERSION } from './version.js';
import { defaultWorkspaceDir, ensureDir, prettyPath } from './workspaces.js';

/** 登录参数。 */
export interface LoginOptions {
  /** 平台地址，例如 https://agent.example.com */
  platformUrl: string;
  /** 本地运行时 */
  runtime: AgentRuntime;
  /** 任务默认工作目录；不传则自动生成 ~/staff-agent-workspaces/<Agent 名> */
  cwd?: string;
}

/** 绑定轮询间隔（毫秒）。 */
const ENROLL_POLL_MS = 2_000;
/** 绑定最长等待时间（毫秒）。 */
const ENROLL_WAIT_MS = 5 * 60 * 1000;

/**
 * 登录流程：
 * 1. 检查平台可达与本地运行时可用
 * 2. 注册设备，拿到 6 位绑定码
 * 3. 在飞书里把码发给机器人（或手机扫码）
 * 4. 拿到设备令牌并落盘
 */
export async function login(options: LoginOptions): Promise<void> {
  const existing = readConfig();
  if (existing && existing.platformUrl === options.platformUrl) {
    log('warn', '本机已登录，重新登录会覆盖原配置', { agent: existing.agentName });
  }

  const adapter = createAdapter(options.runtime);
  const check = await adapter.check();
  if (check.ok) {
    log('info', '运行时检查通过', { runtime: options.runtime, version: check.version });
  } else {
    log('warn', '没有找到该运行时，登录后任务会执行失败', {
      runtime: options.runtime,
      detail: check.detail,
    });
  }

  const health = await checkHealth(options.platformUrl);
  if (!health) {
    throw new Error(`平台不可达：${options.platformUrl}/api/health`);
  }
  if (health.feishu !== 'connected') {
    log('warn', '平台飞书长连接未就绪，绑定码收不到消息', { feishu: health.feishu });
    process.stdout.write(
      '  绑不了的话先查平台日志与飞书开放平台：事件订阅方式选「长连接」、订阅 im.message.receive_v1、版本已发布。\n',
    );
  }

  const anonymous = new PlatformApi(options.platformUrl);
  const machine = machineName();
  const registration = await anonymous.register({
    machineId: machineId(options.platformUrl),
    machineName: machine,
    runtime: options.runtime,
    runtimeVersion: check.version,
    bridgeVersion: BRIDGE_VERSION,
  });

  process.stdout.write('\n');
  log('info', '请完成绑定', { expiresAt: registration.expiresAt });
  process.stdout.write(`\n  绑定码：\x1b[1;32m${registration.code}\x1b[0m\n\n`);
  process.stdout.write('  方式一：打开飞书，找到公司 Agent 机器人，把上面 6 位数字发给它\n');
  if (registration.bindUrl) {
    process.stdout.write('  方式二：用手机扫下面的二维码\n\n');
    qrcode.generate(registration.bindUrl, { small: true }, (art: string) => {
      process.stdout.write(`${art}\n`);
    });
  } else {
    process.stdout.write('  方式二（扫码）：平台未配置公网地址，暂不可用\n\n');
  }
  process.stdout.write('  等待绑定中…\n');

  const deadline = Date.now() + ENROLL_WAIT_MS;
  let lastState = 'pending';
  while (Date.now() < deadline) {
    const poll = await anonymous.enrollPoll(registration.code);
    if (poll.state === 'expired') {
      throw new Error('绑定码已过期，请重新运行 sa login');
    }
    if (poll.state === 'bound') {
      if (!poll.deviceToken) {
        throw new Error('绑定已完成但凭据未下发，请重新运行 sa login');
      }
      const platformUrl = options.platformUrl.replace(/\/$/, '');
      const agentId = poll.agentId ?? '';
      const agentName = poll.agentName ?? 'Agent';
      // 主工作区：显式指定 > 上次登录的目录 > 本地自动生成。
      // 旧版本把路径记在平台，现在完全本地化，不再向平台查询。
      const previousCwd = existing && existsSync(existing.cwd) ? existing.cwd : null;
      const cwd = ensureDir(options.cwd ?? previousCwd ?? defaultWorkspaceDir(agentName));

      writeConfig({
        platformUrl,
        deviceToken: poll.deviceToken,
        agentId,
        agentName,
        runtime: options.runtime,
        cwd,
        machineName: machine,
        // 重新登录不清空本机工作区与职责说明
        description: existing?.description ?? null,
        workspaces: existing?.workspaces ?? [],
        createdAt: new Date().toISOString(),
      });
      process.stdout.write('\n');
      log('info', '登录成功', { agent: agentName, machine, cwd: prettyPath(cwd) });
      process.stdout.write(`\n  主工作区：${prettyPath(cwd)}\n`);
      process.stdout.write('  下一步：运行 \x1b[1msa start --daemon\x1b[0m 让 Agent 常驻\n');
      process.stdout.write('  更多工作区：\x1b[1msa agents add --name <名称>\x1b[0m（只存本机，平台看不到）\n\n');
      return;
    }
    if (lastState !== poll.state) lastState = poll.state;
    await sleep(ENROLL_POLL_MS);
  }
  throw new Error(
    '等待绑定超时（5 分钟），请重新运行 sa login。\n' +
      '  如果飞书里发了绑定码也没反应，多半是飞书应用配置问题：\n' +
      '  1) 开发者后台 → 事件与回调 → 订阅方式选「使用长连接接收事件」\n' +
      '  2) 订阅事件 im.message.receive_v1（接收消息），并开通 im:message / im:message.p2p_msg:readonly 权限\n' +
      '  3) 权限变更后必须创建版本并发布，且机器人可用范围包含你自己\n' +
      '  平台侧可通过日志「收到飞书消息」确认事件是否真的到达。',
  );
}

/** 平台健康状态；feishu 为长连接状态，非 connected 时绑定码收不到消息。 */
async function checkHealth(platformUrl: string): Promise<{ feishu: string } | null> {
  try {
    const response = await fetch(`${platformUrl.replace(/\/$/, '')}/api/health`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { feishu?: string };
    return { feishu: body.feishu ?? 'unknown' };
  } catch (error) {
    log('error', '平台健康检查失败', { error: errorText(error) });
    return null;
  }
}

/** sleep。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
