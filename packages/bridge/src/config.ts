import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { AgentRuntimeSchema } from '@staff-agent/shared';
import { log } from './log.js';
import { prettyPath } from './workspaces.js';
import { configPath } from './paths.js';

/** 本地工作区（= 子 Agent）：一个目录 + 一句职责边界，只存在本机。 */
const WorkspaceSchema = z.object({
  /** 名字，飞书里用 `#名字` 指定 */
  name: z.string().min(1).max(32),
  /** 工作目录（本机绝对路径） */
  cwd: z.string().min(1),
  /** 职责边界，主 Agent 据此判断任务归哪个工作区 */
  description: z.string().nullable(),
  /** 新增时间 */
  createdAt: z.string(),
});

export type Workspace = z.infer<typeof WorkspaceSchema>;

/** 本地配置结构。只保存平台地址、设备令牌、执行偏好与本机工作区。 */
const ConfigSchema = z.object({
  /** 平台地址，例如 https://agent.example.com */
  platformUrl: z.string().url(),
  /** 平台签发的设备令牌 */
  deviceToken: z.string().min(16),
  /** 平台侧 Agent ID */
  agentId: z.string().min(1),
  /** 平台侧 Agent 名称 */
  agentName: z.string().min(1),
  /** 本地运行时 */
  runtime: AgentRuntimeSchema,
  /** 任务默认工作目录 */
  cwd: z.string().min(1),
  /** 机器名（管理员在后台看到的标识） */
  machineName: z.string().min(1),
  /** 主工作区职责说明（可为空，平时不影响执行） */
  description: z.string().nullable().optional(),
  /**
   * 本机额外工作区（子 Agent）。
   * 老配置没有这个字段，默认空数组；这类数据不上传平台，换机需要重新添加。
   */
  workspaces: z.array(WorkspaceSchema).default([]),
  /** 登录时间 */
  createdAt: z.string(),
});

export type BridgeConfig = z.infer<typeof ConfigSchema>;

/** 读取配置；不存在或损坏返回 null。 */
export function readConfig(): BridgeConfig | null {
  const path = configPath();
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    const parsed = ConfigSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** 写入配置，权限 0600（含设备令牌）。 */
export function writeConfig(config: BridgeConfig): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows 不支持 POSIX 权限，忽略
  }
}

/** 删除配置（退出登录）。 */
export function clearConfig(): void {
  const path = configPath();
  if (existsSync(path)) {
    writeFileSync(path, '{}\n', { mode: 0o600 });
  }
}

/** 配置文件 mtime；拿不到返回 null。 */
function configMtimeMs(): number | null {
  try {
    return statSync(configPath()).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * 配置实时视图。
 *
 * `agents add / update / remove` 是另一个进程改 config.json，守护进程如果一直用启动时的快照，
 * 新工作区要重启才生效——曾经因此把「健康管理」相关问题路由到空的主工作区 `~/work`
 * （提示词里根本没列出工作区，模型只能泛泛而谈）。
 * 这里按 mtime 自动重载：文件没变就不重复解析，解析失败沿用上一份。
 */
export class ConfigHandle {
  private current: BridgeConfig;
  private mtimeMs: number | null;

  constructor(initial: BridgeConfig) {
    this.current = initial;
    this.mtimeMs = configMtimeMs();
  }

  /** 取当前配置；文件变过就重读一次。 */
  get(): BridgeConfig {
    const mtimeMs = configMtimeMs();
    if (mtimeMs !== null && mtimeMs !== this.mtimeMs) {
      const next = readConfig();
      if (next) {
        const before = this.current;
        this.current = next;
        this.mtimeMs = mtimeMs;
        log('info', '配置已重新加载', {
          workspaces: next.workspaces.length,
          cwd: prettyPath(next.cwd),
          workspacesBefore: before.workspaces.length,
        });
      }
    }
    return this.current;
  }
}
