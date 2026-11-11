import { z } from 'zod';

/**
 * Agent 本地运行时类型。
 * - pi：通过 `pi --mode rpc` 长驻 JSONL 协议驱动，事件最完整
 * - claude：Claude Code，通过 `-p --output-format stream-json` 驱动
 * - codex：OpenAI Codex CLI，通过 `exec --json` 驱动
 */
export const AgentRuntimeSchema = z.enum(['pi', 'claude', 'codex']);
export type AgentRuntime = z.infer<typeof AgentRuntimeSchema>;

/**
 * Agent 生命周期状态。禁用后平台不再向该 Agent 投递任务。
 */
export const AgentStatusSchema = z.enum(['active', 'disabled']);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

/**
 * 设备（一台员工电脑）状态。撤销后该设备的 token 立即失效。
 */
export const DeviceStatusSchema = z.enum(['active', 'revoked']);
export type DeviceStatus = z.infer<typeof DeviceStatusSchema>;

/**
 * 任务（跑一次 Agent）的状态机。
 * queued → running → succeeded / failed / canceled / timeout
 */
export const RunStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed', 'canceled', 'timeout']);
export type RunStatus = z.infer<typeof RunStatusSchema>;

/** 属于终态的任务状态，用于统计与清理。 */
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['succeeded', 'failed', 'canceled', 'timeout'];

/**
 * trace 步骤类型。
 * - llm：一次模型调用（含 token 用量）
 * - tool：一次工具调用（含耗时、入参出参摘要）
 * - message：一条面向用户的回复片段
 * - thinking：模型思考片段
 * - error：运行时错误
 */
export const StepTypeSchema = z.enum(['llm', 'tool', 'message', 'thinking', 'error']);
export type StepType = z.infer<typeof StepTypeSchema>;

/** 绑定码状态。绑定码一次性使用，5 分钟过期。 */
export const EnrollStateSchema = z.enum(['pending', 'bound', 'expired']);
export type EnrollState = z.infer<typeof EnrollStateSchema>;

/** 本地网关心跳状态，随长轮询请求上报，不单独开心跳链路。 */
export const BridgeStateSchema = z.enum(['idle', 'busy']);
export type BridgeState = z.infer<typeof BridgeStateSchema>;
