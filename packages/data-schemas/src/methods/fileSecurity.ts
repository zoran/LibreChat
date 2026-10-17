/** The File projection carries the upload owner's private receipt, never a separate approval. */
import {
  UPLOAD_MAX_FILE_BYTES,
  isUploadOriginalIntegrity,
  matchesUploadSecurityApproval,
} from 'librechat-data-provider';
import type { UploadSecurityApproval } from 'librechat-data-provider';
import type { FilterQuery } from 'mongoose';
import type { ManagedUploadAcceptance } from '~/types/file';
import type { IMongoFile } from '~/types';

export function uploadSecurityPolicySha256(
  value: unknown = process.env.UPLOAD_SECURITY_POLICY_SHA256,
): string | undefined {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}

/** Called before the first await; ordinary File CRUD cannot supply this projection. */
export function captureManagedFileApproval(
  input: ManagedUploadAcceptance,
  policy: unknown,
): UploadSecurityApproval | undefined {
  const policySha256 = uploadSecurityPolicySha256(policy);
  if (
    !policySha256 ||
    input.receipt.outcome !== 'durable' ||
    !isUploadOriginalIntegrity(input.receipt.integrity, input.receipt.bytes) ||
    !matchesUploadSecurityApproval(
      input.securityApproval,
      {
        tenantId: input.principal.tenantId,
        userId: input.principal.userId,
        operationId: input.operationId,
        transferGeneration: input.transferGeneration,
        mediaType: input.mediaType,
        bytes: input.receipt.bytes,
        sha256: input.receipt.integrity.sha256,
      },
      policySha256,
      input.acceptedAt,
    )
  )
    return undefined;
  const approval = input.securityApproval;
  return { ...approval, subject: { ...approval.subject }, coverage: { ...approval.coverage } };
}

/** Used in the query itself, before counts, names, text or references can leave Mongo. */
export function approvedFileFilter(
  policy: unknown = process.env.UPLOAD_SECURITY_POLICY_SHA256,
  now: number = Date.now(),
): FilterQuery<IMongoFile> {
  const policySha256 = uploadSecurityPolicySha256(policy);
  if (!policySha256) return { _id: { $exists: false } };
  return {
    'securityApproval.version': 1,
    'securityApproval.decision': 'approved',
    'securityApproval.policySha256': policySha256,
    'securityApproval.checkedAt': {
      $regex: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      $lte: new Date(now).toISOString(),
    },
    'securityApproval.scannerVersion': { $regex: /^[a-zA-Z0-9][a-zA-Z0-9/._:+-]{0,127}$/ },
    'securityApproval.coverage.complete': true,
    'securityApproval.coverage.pages': { $gte: 1, $lte: 500 },
    'securityApproval.coverage.parts': { $gte: 1, $lte: 2048 },
    'securityApproval.subject.sha256': { $regex: /^[a-f0-9]{64}$/ },
    'securityApproval.subject.bytes': { $gt: 0, $lte: UPLOAD_MAX_FILE_BYTES },
    'securityApproval.subject.transferGeneration': { $gt: 0 },
    source: 's3',
    $expr: {
      $and: [
        {
          $eq: [
            '$securityApproval.checkedAt',
            {
              $dateToString: {
                date: {
                  $convert: {
                    input: '$securityApproval.checkedAt',
                    to: 'date',
                    onError: null,
                    onNull: null,
                  },
                },
                format: '%Y-%m-%dT%H:%M:%S.%LZ',
                timezone: 'UTC',
                onNull: '',
              },
            },
          ],
        },
        ...['coverage.pages', 'coverage.parts', 'subject.bytes', 'subject.transferGeneration'].map(
          (field) => ({
            $eq: [
              `$securityApproval.${field}`,
              {
                $floor: {
                  $convert: {
                    input: `$securityApproval.${field}`,
                    to: 'double',
                    onError: 0,
                    onNull: 0,
                  },
                },
              },
            ],
          }),
        ),
        { $eq: ['$securityApproval.subject.tenantId', '$tenantId'] },
        { $eq: ['$securityApproval.subject.userId', { $toString: '$user' }] },
        { $eq: ['$securityApproval.subject.operationId', '$uploadOperationId'] },
        { $eq: ['$uploadOperationId', '$file_id'] },
        { $eq: ['$securityApproval.subject.mediaType', '$type'] },
        { $eq: ['$securityApproval.subject.bytes', '$bytes'] },
        {
          $eq: [
            '$storageKey',
            {
              $concat: [
                {
                  $cond: [{ $eq: ['$tenantId', null] }, '', { $concat: ['t/', '$tenantId', '/'] }],
                },
                'managed-uploads/',
                { $toString: '$user' },
                '/',
                '$file_id',
                '.',
                { $toString: '$securityApproval.subject.transferGeneration' },
                '__original',
              ],
            },
          ],
        },
      ],
    },
  };
}
