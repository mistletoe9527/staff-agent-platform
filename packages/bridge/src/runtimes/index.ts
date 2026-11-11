import type { AgentRuntime } from '@staff-agent/shared';
import type { RuntimeAdapter } from './types.js';
import { PiAdapter } from './pi.js';
import { ClaudeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';

/** 按运行时类型创建适配器。 */
export function createAdapter(runtime: AgentRuntime): RuntimeAdapter {
  switch (runtime) {
    case 'pi':
      return new PiAdapter();
    case 'claude':
      return new ClaudeAdapter();
    case 'codex':
      return new CodexAdapter();
  }
}

export type { RuntimeAdapter } from './types.js';
export type { StepEvent, RunOutcome, RunOptions } from './types.js';
