import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { AgentRuntimeSchema } from '@staff-agent/shared';
import { configPath } from './paths.js';

/** 本地配置结构。只保存平台地址、设备令牌与执行偏好。 */
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
