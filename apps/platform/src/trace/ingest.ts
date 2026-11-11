import type { StepInput } from '@staff-agent/shared';
import type { Db } from '../db/client.js';
import { insertSteps } from '../domain/steps.js';
import { redact } from '../trace/redact.js';

/**
 * trace 入库：先脱敏再落库。
 * 所有步骤摘要都经过同一层，避免某个 adapter 忘记脱敏把密钥写进数据库。
 */
export function ingestSteps(db: Db, runId: string, steps: StepInput[], maxChars: number): number {
  const sanitized: StepInput[] = steps.map((step) => ({
    ...step,
    inputSummary: redact(step.inputSummary, maxChars) ?? undefined,
    outputSummary: redact(step.outputSummary, maxChars) ?? undefined,
  }));
  return insertSteps(db, runId, sanitized);
}
