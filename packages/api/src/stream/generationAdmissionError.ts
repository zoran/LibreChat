/** Closed acquisition diagnostics; custody and admission decisions remain with the coordinator. */
import { logger } from '@librechat/data-schemas';
import type { GenerationAdmissionResult } from '@librechat/data-schemas';
import type { GenerationAdmissionRefusalReason } from './generationAdmissionMetrics';
import { recordGenerationAdmissionRefusal } from './generationAdmissionMetrics';
export type { GenerationAdmissionRefusalReason } from './generationAdmissionMetrics';

const acquisitionReasons = new Set<unknown>([
  'INVALID_INPUT',
  'REQUEST_CONFLICT',
  'CONVERSATION_ACTIVE',
  'HELD',
  'OUTCOME_UNKNOWN',
  'ALREADY_ADMITTED',
]);

export class GenerationAdmissionHeldError extends Error {
  readonly code = 'GENERATION_ADMISSION_HELD';
  readonly status = 409;
  readonly stage: 'acquire' | undefined;
  constructor(readonly reason?: GenerationAdmissionRefusalReason | undefined) {
    super('Generation work is held; a confirmed admission or settlement is required');
    this.stage = reason === undefined ? undefined : 'acquire';
  }
}

/** Unknown runtime shapes expose no value; a diagnostic never grants dispatch or drops custody. */
export function acquireHeldError(
  result: GenerationAdmissionResult<{ acquired: boolean }>,
): GenerationAdmissionHeldError {
  const reason = result.ok ? 'ALREADY_ADMITTED' : result.error.code;
  if (!acquisitionReasons.has(reason)) return new GenerationAdmissionHeldError();
  const error = new GenerationAdmissionHeldError(reason);
  try {
    recordGenerationAdmissionRefusal(reason);
  } catch {
    // A diagnostic observer never replaces the original refusal or grants admission.
  }
  try {
    logger.warn(
      JSON.stringify({
        event: 'generation_admission_refused',
        code: error.code,
        stage: error.stage,
        reason: error.reason,
      }),
    );
  } catch {
    // Preserve the original denial even when the existing logger is unavailable.
  }
  return error;
}
