import type { FileCoverageFailureCode } from 'librechat-data-provider';
export const BUDGET = 3000,
  RESERVE = 150;
export class CoverageError extends Error {
  constructor(readonly code: FileCoverageFailureCode) {
    super(code);
  }
}
export function fail(code: FileCoverageFailureCode): never {
  throw new CoverageError(code);
}
export function censusValue(value: unknown): unknown {
  if (Array.isArray(value)) return ['array', value.map(censusValue)];
  if (value && typeof value === 'object')
    return [
      'object',
      Object.entries(value)
        .sort(([a], [b]) => {
          if (a === b) return 0;
          return a < b ? -1 : 1;
        })
        .map(([key, item]) => [key, censusValue(item)]),
    ];
  return value;
}

export const fields: Record<string, number> = Object.fromEntries(
  [
    '_id',
    'user',
    'tenantId',
    'file_id',
    'expiredAt',
    'expiresAt',
    'retentionAcceptedAt',
    'retentionRevision',
    'retentionActivity',
    'derivedRetention',
    'derivedOrigin',
    'retentionRevocationId',
    'deletionRequestedAt',
    'deletionCompletedAt',
    'deletionRetryAt',
    'deletionAttempts',
    'uploadOperationId',
  ].map((key) => [key, 1]),
);
