/** upload-security fixtures supply synthetic contract records, never scanner or runtime proof. */
import type {
  UploadSecuritySubject,
  UploadSecurityApproval,
  UploadSecurityExecution,
  UploadSecuritySettlement,
} from '../upload-security';
import { antivirusFixture } from './upload-antivirus';

export const policySha256 = 'a'.repeat(64);
export const now = Date.parse('2026-10-17T02:00:00.000Z');
export const subject = (): UploadSecuritySubject => ({
  tenantId: 'tenant-a',
  userId: 'user-1',
  operationId: 'operation-1',
  transferGeneration: 1,
  mediaType: 'text/plain',
  bytes: 8,
  sha256: 'b'.repeat(64),
});
export const approval = (): UploadSecurityApproval => ({
  version: 2,
  antivirus: antivirusFixture(subject(), now, '2026-10-17T03:00:00.000Z').approval,
  decision: 'approved',
  policySha256,
  subject: subject(),
  scannerVersion: 'local-inspector/v1.2.3+build-4',
  checkedAt: new Date(now).toISOString(),
  coverage: { complete: true, pages: 1, parts: 1 },
});

export function accessor(value: object, key: string, get: () => unknown): object {
  return Object.defineProperty({ ...value }, key, { enumerable: true, get });
}

export const execution = (): UploadSecurityExecution => ({
  version: 3,
  antivirus: antivirusFixture(subject(), now, '2026-10-17T03:00:00.000Z').custody,
  custody: { kind: 'none' as const },
  attemptId: 'operation-1.1',
  instanceId: '12345678-9abc-4def-8123-456789abcdef',
  executionId: 'abcdef01-2345-4678-9abc-def012345678',
  expiresAt: '2026-10-17T03:00:00.000Z',
});
export const settlement = (): UploadSecuritySettlement => ({
  execution: execution(),
  antivirusReceipt: antivirusFixture(subject(), now, '2026-10-17T03:00:00.000Z').receipt,
  writerStopped: true,
  transientDataRemoved: true,
});
