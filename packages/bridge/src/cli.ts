#!/usr/bin/env node
import { Command } from 'commander';
import { z } from 'zod';
import { AgentRuntimeSchema, type AgentRuntime } from '@staff-agent/shared';
import { PlatformApi } from './api.js';
import { readConfig, writeConfig, clearConfig, ConfigHandle } from './config.js';
import { isRunning, readPid, startDaemon, stopDaemon, safeUnlinkPid } from './daemon.js';
import { login } from './login.js';
import { addAgent, listAgents, removeAgent, updateAgent } from './agents.js';
import { prettyPath } from './workspaces.js';
import { log, errorText } from './log.js';
import { Poller, BRIDGE_VERSION } from './poller.js';
import { createAdapter } from './runtimes/index.js';
import { configPath, logPath, pidPath } from './paths.js';

const program = new Command();

program
  .name('sa')
  .description('本地 Agent 网关：把公司平台的任务交给本机 pi / Claude Code / Codex 执行（简写 sa，兼容旧命令 staff-agent）')
  .version(BRIDGE_VERSION);

/** 解析运行时参数。 */
function parseRuntime(value: string): AgentRuntime {
  const parsed = AgentRuntimeSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`不支持的运行时 ${value}，可选：pi、claude、codex`);
  }
  return parsed.data;
}

program
  .command('login')
  .description('登录并绑定飞书身份')
  .requiredOption('--platform <url>', '平台地址，例如 https://agent.example.com')
  .option('--runtime <runtime>', '本地运行时：pi | claude | codex', 'pi')
  .option('--cwd <dir>', '主 Agent 工作目录，默认自动生成 ~/staff-agent-workspaces/<Agent 名>')
  .action(async (options: { platform: string; runtime: string; cwd?: string }) => {
    try {
      z.string().url().parse(options.platform);
      await login({
        platformUrl: options.platform,
        runtime: parseRuntime(options.runtime),
        cwd: options.cwd,
      });
    } catch (error) {
      log('error', '登录失败', { error: errorText(error) });
      process.exitCode = 1;
    }
  });

// Agent 管理：一个 Agent 一个工作目录
const agents = program.command('agents').description('管理本机 Agent（每个 Agent 一个工作目录）');

agents
  .command('list')
  .description('列出主工作区与自定义工作区（本机配置）')
  .action(async () => {
    try {
      await listAgents();
    } catch (error) {
      log('error', '读取工作区列表失败', { error: errorText(error) });
      process.exitCode = 1;
    }
  });

agents
  .command('add')
  .description('新增工作区（子 Agent）：只存本机，配置目录与职责，描述留空则让 Agent 自己读目录总结')
  .requiredOption('--name <name>', '工作区名称，飞书里用 #名称 指定')
  .option('--cwd <dir>', '工作目录，默认 ~/staff-agent-workspaces/<名称>')
  .option('--description <text>', '工作区职责边界，留空则由 Agent 阅读目录自动生成')
  .option('--no-ai-description', '不自动生成描述')
  .action(async (options: { name: string; cwd?: string; description?: string; aiDescription?: boolean }) => {
    try {
      await addAgent({
        name: options.name,
        cwd: options.cwd,
        description: options.description,
        aiDescription: options.aiDescription,
      });
    } catch (error) {
      log('error', '新增工作区失败', { error: errorText(error) });
      process.exitCode = 1;
    }
  });

agents
  .command('update <name>')
  .description('修改工作区的工作目录或职责说明')
  .option('--cwd <dir>', '新的工作目录')
  .option('--description <text>', '新的职责说明')
  .option('--ai-description', '让 Agent 重新阅读目录并生成职责说明')
  .action(async (name: string, options: { cwd?: string; description?: string; aiDescription?: boolean }) => {
    try {
      await updateAgent({ name, cwd: options.cwd, description: options.description, aiDescription: options.aiDescription });
    } catch (error) {
      log('error', '更新工作区失败', { error: errorText(error) });
      process.exitCode = 1;
    }
  });

agents
  .command('remove <name>')
  .alias('rm')
  .description('删除工作区（只删本机配置，工作目录保留）')
  .action(async (name: string) => {
    try {
      await removeAgent(name);
    } catch (error) {
      log('error', '删除工作区失败', { error: errorText(error) });
      process.exitCode = 1;
    }
  });

program
  .command('start')
  .description('启动网关，长轮询接收任务')
  .option('--daemon', '后台运行')
  .option('--foreground', '前台运行（后台模式内部使用）')
  .option('--cwd <dir>', '覆盖任务工作目录')
  .action(async (options: { daemon?: boolean; foreground?: boolean; cwd?: string }) => {
    try {
      const config = readConfig();
      if (!config) {
        log('error', '尚未登录，请先运行 sa login --platform <url>');
        process.exitCode = 1;
        return;
      }
      if (options.cwd) {
        config.cwd = options.cwd;
        writeConfig(config);
      }
      if (options.daemon) {
        startDaemon();
        return;
      }
      await runForeground(config);
    } catch (error) {
      log('error', '启动失败', { error: errorText(error) });
      process.exitCode = 1;
    }
  });

program
  .command('stop')
  .description('停止后台网关')
  .action(() => {
    if (!stopDaemon()) {
      log('info', '网关没有在运行');
    }
  });

program
  .command('status')
  .description('查看登录与运行状态')
  .action(async () => {
    const config = readConfig();
    if (!config) {
      log('info', '未登录', { config: configPath() });
      return;
    }
    const pid = readPid();
    const running = pid ? isRunning(pid) : false;
    const adapter = createAdapter(config.runtime);
    const check = await adapter.check();
    process.stdout.write(
      JSON.stringify(
        {
          platform: config.platformUrl,
          agent: config.agentName,
          agentId: config.agentId,
          runtime: config.runtime,
          runtimeAvailable: check.ok,
          runtimeVersion: check.version ?? null,
          cwd: prettyPath(config.cwd),
          // 工作区只在本机，平台不感知
          workspaces: config.workspaces.map((workspace) => ({
            name: workspace.name,
            cwd: prettyPath(workspace.cwd),
            description: workspace.description,
          })),
          machine: config.machineName,
          loggedInAt: config.createdAt,
          daemon: running ? { running: true, pid } : { running: false },
        },
        null,
        2,
      ) + '\n',
    );
  });

program
  .command('logout')
  .description('删除本地凭据')
  .action(() => {
    const pid = readPid();
    if (pid && isRunning(pid)) stopDaemon();
    clearConfig();
    safeUnlinkPid();
    log('info', '已退出登录');
  });

program
  .command('logs')
  .description('显示日志文件路径（网关日志 + 守护进程输出）')
  .action(() => {
    const daemonLog = `${pidPath().replace(/bridge\.pid$/, '')}logs/daemon.log`;
    process.stdout.write(`网关日志：${logPath()}\n`);
    process.stdout.write(`守护输出：${daemonLog}\n`);
    process.stdout.write(`实时查看：tail -f ${logPath()}\n`);
  });

program
  .command('doctor')
  .description('检查平台连通性与本地运行时')
  .action(async () => {
    const config = readConfig();
    if (!config) {
      log('error', '未登录，无法检查平台连通性');
    }
    const results: Record<string, unknown> = {};
    for (const runtime of ['pi', 'claude', 'codex'] as const) {
      const check = await createAdapter(runtime).check();
      results[runtime] = check.ok ? { ok: true, version: check.version } : { ok: false, detail: check.detail };
    }
    if (config) {
      try {
        const response = await fetch(`${config.platformUrl}/api/health`, { signal: AbortSignal.timeout(8_000) });
        results.platform = { ok: response.ok, status: response.status };
      } catch (error) {
        results.platform = { ok: false, detail: errorText(error) };
      }
    }
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  });

/** 前台运行主循环。 */
async function runForeground(config: NonNullable<ReturnType<typeof readConfig>>): Promise<void> {
  const controller = new AbortController();
  const api = new PlatformApi(config.platformUrl, config.deviceToken);
  const poller = new Poller(api, new ConfigHandle(config));

  const shutdown = (signal: string): void => {
    log('info', '收到退出信号，正在收尾', { signal });
    poller.stop();
    controller.abort();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  // 后台模式由 daemon 写 PID，这里在退出时清理
  process.once('exit', () => {
    if (process.env.STAFF_AGENT_DAEMON === '1') safeUnlinkPid();
  });

  await poller.run(controller.signal);
}

program.parseAsync(process.argv).catch((error: unknown) => {
  log('error', '命令执行失败', { error: errorText(error) });
  process.exit(1);
});
