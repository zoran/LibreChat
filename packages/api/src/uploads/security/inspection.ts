/** Internal scanner evidence. Byte binding, execution isolation and approval remain with the worker. */
import { inspectSecurityMarkings } from './markings';
import type {
  SecurityMarkingEvidence,
  SecurityMarkingPolicy,
  SecurityMarkingResult,
} from './markings';

export const SECURITY_INSPECTION_VERSION = 'complete-content-v3';
export type SecurityInspectionResult =
  | Exclude<SecurityMarkingResult, { decision: 'clear' }>
  | { decision: 'clear'; coverage: { complete: true; pages: number; parts: number } };

/** Only a complete, validated evidence set can supply a positive coverage result. */
export function inspectCompleteSecurityEvidence(
  policy: SecurityMarkingPolicy,
  evidence: SecurityMarkingEvidence,
): SecurityInspectionResult {
  try {
    // Preserve closed-record validation while reading exactly the coverage that is classified.
    const properties = Object.getOwnPropertyDescriptors(evidence);
    const descriptor = properties.coverage;
    if (!descriptor || !('value' in descriptor)) {
      return { decision: 'uninspectable', reason: 'invalid_content' };
    }
    const coverage = Object.create(
      Object.getPrototypeOf(descriptor.value),
      Object.getOwnPropertyDescriptors(descriptor.value),
    ) as SecurityMarkingEvidence['coverage'];
    properties.coverage = { ...descriptor, value: coverage };
    const snapshot = Object.create(Object.getPrototypeOf(evidence), properties);
    const result = inspectSecurityMarkings(policy, snapshot);
    if (result.decision !== 'clear') return result;
    return {
      decision: 'clear',
      coverage: { complete: true, pages: coverage.pages, parts: coverage.parts },
    };
  } catch {
    return { decision: 'uninspectable', reason: 'invalid_content' };
  }
}
