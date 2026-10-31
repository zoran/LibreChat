/** NAS admission checks the normal immutable client policy; repository preconditions own retired settlement. */
import {
  readUploadSecurityApproval,
  readUploadSecurityExecution,
  matchesCurrentUploadAntivirus,
} from 'librechat-data-provider';
import type { NasAntivirusAdmission } from '@librechat/data-schemas';
import { parseNasAntivirusClientPolicy } from './antivirusAdmissionPolicy';
export function createNasAntivirusAdmissionGuard(options: {
  policy: unknown;
  securityPolicySha256: string;
  now?: () => number;
}): NasAntivirusAdmission {
  const policy = parseNasAntivirusClientPolicy(options.policy);
  if (!/^[a-f0-9]{64}$/.test(options.securityPolicySha256))
    throw new Error('NAS antivirus policy unavailable');
  const now = options.now ?? Date.now;
  return (input) => {
    const approval = readUploadSecurityApproval(input.approval);
    const execution = readUploadSecurityExecution(input.execution);
    if (!approval || approval.version !== 2 || !execution || execution.version !== 3) return false;
    const av = execution.antivirus;
    return (
      approval.policySha256 === options.securityPolicySha256 &&
      av.runtimeImage === policy.image &&
      av.sourceRevision === policy.sourceRevision &&
      policy.slots.includes(av.slot) &&
      JSON.stringify(approval.subject) ===
        JSON.stringify({
          tenantId: input.tenantId,
          userId: input.userId,
          operationId: input.operationId,
          transferGeneration: input.generation,
          mediaType: input.mediaType,
          bytes: input.bytes,
          sha256: input.sha256,
        }) &&
      matchesCurrentUploadAntivirus(approval.antivirus, av, now(), policy)
    );
  };
}
