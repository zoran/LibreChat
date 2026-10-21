/** Read-only current usage proofs. Auth and managed File owners retain all write authority. */
import { performance } from 'node:perf_hooks';
import type { StoredUpload } from './uploadManagementStore';
import { hasCurrentUploadSecurityApproval } from './uploadManagement.security';
import { approvedFileFilter } from './fileSecurity';

export interface StatusUsageCurrentPolicy {
  readonly configured: true;
  readonly tenantId: string;
  readonly policyVersion: number;
  readonly domains: readonly string[];
  readonly qualification?: { readonly email: string; readonly notAfter: number };
  readonly uploadSecurityPolicySha256: string;
}
export interface StatusUsageCurrentProof {
  value: number | null;
  asOfMs: number;
  queryCompleted: boolean;
  gap: 'query_timeout' | 'capacity' | 'unsupported_classification' | 'unavailable' | null;
}
export interface StatusUsageCurrentMethods {
  readCurrentAccounts(asOfMs: number): Promise<StatusUsageCurrentProof>;
  readCurrentOriginalDocuments(asOfMs: number): Promise<StatusUsageCurrentProof>;
}
const MAX_ROWS = 10_000;
const OPERATION_MS = 2_000;
const READ_MS = 4_000;
type Stage = Record<string, unknown>;
const absent = (field: string) => ({ $eq: [{ $ifNull: [field, null] }, null] });
const integer = (field: string) => {
  const number = { $convert: { input: field, to: 'double', onError: null, onNull: null } };
  return {
    $and: [
      { $in: [{ $type: field }, ['int', 'long', 'double', 'decimal']] },
      { $gte: [number, -Number.MAX_SAFE_INTEGER] },
      { $lte: [number, Number.MAX_SAFE_INTEGER] },
      { $eq: [number, { $trunc: number }] },
    ],
  };
};

/** Construct only from deployment-owned policy, never a request body or public Mongo selector. */
export function createStatusUsageCurrentMethods(
  mongoose: typeof import('mongoose'),
  input: StatusUsageCurrentPolicy,
): StatusUsageCurrentMethods {
  if (
    typeof input !== 'object' ||
    input === null ||
    Array.isArray(input) ||
    input.configured !== true ||
    typeof input.tenantId !== 'string' ||
    !/^[a-zA-Z0-9_.-]{1,128}$/.test(input.tenantId) ||
    input.tenantId === '__SYSTEM__' ||
    !Number.isSafeInteger(input.policyVersion) ||
    input.policyVersion < 1 ||
    !Array.isArray(input.domains) ||
    input.domains.length > 100 ||
    input.domains.some(
      (d) => typeof d !== 'string' || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,63}$/.test(d),
    ) ||
    typeof input.uploadSecurityPolicySha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(input.uploadSecurityPolicySha256) ||
    (input.qualification !== undefined &&
      (typeof input.qualification !== 'object' ||
        input.qualification === null ||
        Array.isArray(input.qualification) ||
        typeof input.qualification.email !== 'string' ||
        input.qualification.email.length > 254 ||
        !/^[a-z0-9][a-z0-9._+-]*@[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,63}$/.test(
          input.qualification.email,
        ) ||
        !Number.isSafeInteger(input.qualification.notAfter)))
  ) {
    throw new Error('STATUS_USAGE_POLICY_INVALID');
  }
  const policy = Object.freeze({
    ...input,
    domains: Object.freeze([...input.domains]),
    qualification: input.qualification ? Object.freeze({ ...input.qualification }) : undefined,
  });

  async function read(
    modelName: string,
    asOfMs: number,
    build: () => Stage[],
  ): Promise<StatusUsageCurrentProof> {
    const gap = (cause: StatusUsageCurrentProof['gap']): StatusUsageCurrentProof => ({
      value: null,
      asOfMs,
      queryCompleted: false,
      gap: cause,
    });
    if (!Number.isSafeInteger(asOfMs) || asOfMs < 0 || asOfMs > 8_640_000_000_000_000)
      return gap('unavailable');
    const started = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), READ_MS);
    let session: import('mongoose').ClientSession | undefined;
    let cursorId: import('mongoose').mongo.Long | undefined;
    let db: typeof mongoose.connection.db;
    let collectionName: string | undefined;
    const budget = () =>
      Math.max(0, Math.min(OPERATION_MS, Math.floor(READ_MS - (performance.now() - started))));
    try {
      const model = mongoose.models[modelName];
      if (!model) return gap('unavailable');
      const pipeline = build();
      const remaining = Math.floor(READ_MS - (performance.now() - started));
      if (remaining <= 0) return gap('query_timeout');
      db = model.db.db;
      if (!db) return gap('unavailable');
      ({ collectionName } = model.collection);
      session = model.db.getClient().startSession({ causalConsistency: false });
      // A single facet result fits in one batch. Db.command owns no AbstractCursor
      // and therefore cannot start detached cleanup or refresh a cursor deadline.
      const operationMs = budget();
      if (operationMs <= 0) return gap('query_timeout');
      const reply = await db.command(
        {
          aggregate: collectionName,
          pipeline,
          cursor: { batchSize: 2 },
          readConcern: { level: 'snapshot' },
          maxTimeMS: operationMs,
          allowDiskUse: false,
        },
        {
          readPreference: 'primary',
          timeoutMS: operationMs,
          signal: controller.signal,
          session,
          promoteLongs: true,
        },
      );
      const receivedCursorId = reply.cursor?.id;
      if (typeof receivedCursorId === 'number' && Number.isSafeInteger(receivedCursorId)) {
        cursorId = mongoose.mongo.Long.fromNumber(receivedCursorId);
      } else if (mongoose.mongo.Long.isLong(receivedCursorId)) {
        cursorId = receivedCursorId;
      } else {
        cursorId = undefined;
      }
      if (!cursorId || !cursorId.isZero()) return gap('unavailable');
      const result = reply.cursor.firstBatch;
      if (!Array.isArray(result)) return gap('unavailable');
      if (controller.signal.aborted || performance.now() - started >= READ_MS)
        return gap('query_timeout');
      if (result.length !== 1) return gap('unavailable');
      const row = result[0];
      if (row.legacy?.length || row.invalid?.length) return gap('unsupported_classification');
      if (!Array.isArray(row.count) || row.count.length > 1) return gap('unavailable');
      const value = row.count.length === 0 ? 0 : row.count[0].value;
      if (!Number.isSafeInteger(value) || value < 0) return gap('unavailable');
      if (value > MAX_ROWS) return gap('capacity');
      if (modelName === 'File') {
        if (!Array.isArray(row.publications) || row.publications.length !== value)
          return gap('unsupported_classification');
        for (const operation of row.publications as StoredUpload[]) {
          if (performance.now() - started >= READ_MS) return gap('query_timeout');
          if (
            !hasCurrentUploadSecurityApproval(operation, policy.uploadSecurityPolicySha256, asOfMs)
          )
            return gap('unsupported_classification');
        }
      }
      if (controller.signal.aborted || performance.now() - started >= READ_MS)
        return gap('query_timeout');
      return { value, asOfMs, queryCompleted: true, gap: null };
    } catch (error) {
      const e = error as { code?: number; name?: string };
      return gap(
        controller.signal.aborted ||
          e.code === 50 ||
          ['MongoOperationTimeoutError', 'MongoNetworkTimeoutError', 'AbortError'].includes(
            e.name ?? '',
          )
          ? 'query_timeout'
          : 'unavailable',
      );
    } finally {
      // No implicit cursor cleanup. Await every command and release this nontransactional
      // session locally. A malformed/unexpected cursor never becomes complete evidence.
      const cleanupMs = budget();
      if (cleanupMs > 0 && db && collectionName && cursorId && !cursorId.isZero()) {
        await db
          .command(
            { killCursors: collectionName, cursors: [cursorId] },
            { session, timeoutMS: cleanupMs },
          )
          .catch(() => undefined);
      }
      await session?.endSession();
      clearTimeout(timer);
    }
  }

  function accounts(asOfMs: number): Stage[] {
    const now = new Date(asOfMs);
    const email = { $convert: { input: '$email', to: 'string', onError: '', onNull: '' } };
    const recipient = {
      $and: [
        { $eq: [email, { $toLower: { $trim: { input: email } } }] },
        { $regexMatch: { input: email, regex: /^[^\s@<>]+@[^\s@<>]+$/ } },
        {
          $or: [
            { $in: [{ $arrayElemAt: [{ $split: [email, '@'] }, -1] }, policy.domains] },
            ...(policy.qualification && asOfMs < policy.qualification.notAfter
              ? [{ $eq: [email, policy.qualification.email] }]
              : []),
          ],
        },
      ],
    };
    return [
      {
        $match: {
          tenantId: policy.tenantId,
          authMethod: 'email_code',
          authPolicyVersion: policy.policyVersion,
          revokedAt: null,
          authCreatedAt: { $type: 'date' },
          expiration: { $gt: now },
          idleExpiresAt: { $gt: now },
          $expr: {
            $and: [
              integer('$authVersion'),
              integer('$authPolicyVersion'),
              integer('$refreshGeneration'),
            ],
          },
        },
      },
      {
        $lookup: {
          from: (({ collectionName }) => collectionName)(mongoose.models.User.collection),
          let: { user: '$user', version: '$authVersion', created: '$authCreatedAt' },
          pipeline: [
            {
              $match: {
                tenantId: policy.tenantId,
                provider: 'email_code',
                emailVerified: true,
                authDisabled: { $ne: true },
                agentTriggerDeletionStartedAt: null,
                $expr: {
                  $and: [
                    { $eq: ['$_id', '$$user'] },
                    { $eq: [{ $ifNull: ['$authVersion', 0] }, '$$version'] },
                    {
                      $or: [
                        absent('$credentialsChangedAt'),
                        { $lt: ['$credentialsChangedAt', '$$created'] },
                      ],
                    },
                    {
                      $or: [
                        absent('$twoFactorEnrolledAt'),
                        { $lte: ['$twoFactorEnrolledAt', '$$created'] },
                      ],
                    },
                    recipient,
                  ],
                },
              },
            },
            { $project: { _id: 1 } },
            { $limit: 1 },
          ],
          as: 'account',
        },
      },
      { $match: { 'account.0': { $exists: true } } },
      { $group: { _id: '$user' } },
      { $limit: MAX_ROWS + 1 },
      { $facet: { count: [{ $count: 'value' }] } },
    ];
  }

  function documents(asOfMs: number): Stage[] {
    const now = new Date(asOfMs);
    return [
      { $match: { tenantId: policy.tenantId, derivedOrigin: { $exists: false } } },
      {
        $facet: {
          legacy: [
            {
              $match: {
                $or: [{ uploadOperationId: { $exists: false } }, { retentionAcceptedAt: null }],
              },
            },
            { $limit: 1 },
            { $project: { _id: 1 } },
          ],
          count: [
            {
              $match: {
                retentionAcceptedAt: { $type: 'date', $lte: now },
                status: 'ready',
                expiredAt: { $gt: now },
                deletionRequestedAt: null,
                deletionCompletedAt: null,
                ...approvedFileFilter(policy.uploadSecurityPolicySha256, asOfMs),
              },
            },
            {
              $lookup: {
                from: (({ collectionName }) => collectionName)(
                  mongoose.models.UploadOperation.collection,
                ),
                let: {
                  id: '$uploadOperationId',
                  user: { $toString: '$user' },
                  accepted: { $toLong: '$retentionAcceptedAt' },
                  expires: { $toLong: '$expiredAt' },
                  revision: '$previewRevision',
                  bytes: '$bytes',
                  storage: '$storageKey',
                  sha: '$securityApproval.subject.sha256',
                },
                pipeline: [
                  {
                    $match: {
                      tenantId: policy.tenantId,
                      state: 'ready',
                      derivedOrigin: { $exists: false },
                      writerStopped: true,
                      originalRemoved: { $ne: true },
                      textRemoved: { $ne: true },
                      publishedDigest: { $regex: /^[a-f0-9]{64}$/ },
                      'original.outcome': 'durable',
                      'original.source': 's3',
                      'securityApproval.policySha256': policy.uploadSecurityPolicySha256,
                      $expr: {
                        $and: [
                          { $eq: ['$_id', '$$id'] },
                          { $eq: ['$userId', '$$user'] },
                          { $eq: ['$acceptedAt', '$$accepted'] },
                          { $eq: ['$expiresAt', '$$expires'] },
                          { $eq: [{ $toString: '$generation' }, '$$revision'] },
                          { $eq: ['$actualBytes', '$$bytes'] },
                          { $eq: ['$original.bytes', '$$bytes'] },
                          { $eq: ['$original.storageKey', '$$storage'] },
                          { $eq: ['$original.integrity.sha256', '$$sha'] },
                        ],
                      },
                    },
                  },
                  {
                    $project: {
                      _id: 1,
                      tenantId: 1,
                      userId: 1,
                      mediaType: 1,
                      declaredBytes: 1,
                      actualBytes: 1,
                      attemptGeneration: 1,
                      original: 1,
                      securityApproval: 1,
                      securityExecution: 1,
                      securitySettlement: 1,
                    },
                  },
                  { $limit: 2 },
                ],
                as: 'publication',
              },
            },
            {
              $group: {
                _id: '$file_id',
                valid: { $min: { $eq: [{ $size: '$publication' }, 1] } },
                publication: { $first: { $arrayElemAt: ['$publication', 0] } },
              },
            },
            { $project: { _id: 0, valid: 1, publication: 1 } },
            { $limit: MAX_ROWS + 1 },
          ],
        },
      },
      {
        $project: {
          legacy: 1,
          invalid: {
            $filter: { input: '$count', as: 'row', cond: { $eq: ['$$row.valid', false] } },
          },
          count: [{ value: { $size: '$count' } }],
          publications: { $map: { input: '$count', as: 'row', in: '$$row.publication' } },
        },
      },
    ];
  }
  return Object.freeze({
    readCurrentAccounts: (asOfMs: number) => read('Session', asOfMs, () => accounts(asOfMs)),
    readCurrentOriginalDocuments: (asOfMs: number) => read('File', asOfMs, () => documents(asOfMs)),
  });
}
