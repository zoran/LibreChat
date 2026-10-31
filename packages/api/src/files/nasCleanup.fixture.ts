/** Cleanup integration fixture: real NAS/S3 factories and repository; only DB/S3 boundaries are inert. */
/** Cleanup integration fixture: real NAS/S3 factories and repository; only DB/S3 boundaries are inert. */
import { mongo } from 'mongoose';
import { Readable } from 'node:stream';
import { mockClient } from 'aws-sdk-client-mock';
import { sdkStreamMixin } from '@smithy/util-stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import type { UploadLease, UploadPrincipal, UploadSecurityApproval } from 'librechat-data-provider';
import type { UploadNasMethods } from '@librechat/data-schemas';
import type { UploadManagementContext } from '../../../data-schemas/src/methods/uploadManagementContext';
import type { StoredUpload } from '../../../data-schemas/src/methods/uploadManagementState';
import { createUploadCleanupTransitions } from '../../../data-schemas/src/methods/uploadManagementCleanup';
import { validateNasUploadState } from '../../../data-schemas/src/methods/uploadManagementNasState';
import { createUploadNasMethods } from '../../../data-schemas/src/methods/uploadManagementNas';
import { createOriginalIntegrity } from '../uploads/storage/integrity';
import { createNasS3Storage } from '../storage/nas/storage';
import { createNasS3Client } from '../storage/nas/client';

const payload = Buffer.from('hello');
const identity = createOriginalIntegrity(payload.length);
identity.update(payload);
const integrity = identity.finish();
export const principal: UploadPrincipal = {
  authentication: 'verified-email',
  tenantId: 'tenant',
  userId: 'user',
};
const policy = 'c'.repeat(64);
export const backend = {
  kind: 'nas-s3' as const,
  uid: 'nas-1',
  configurationSha256: 'b'.repeat(64),
  protocol: 'acknowledged-only-v1' as const,
};
const clients: ReturnType<typeof createNasS3Client>[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.destroy();
});

export function nasFixture(av = true) {
  const now = Date.now();
  const lease: UploadLease = {
    tenantId: 'tenant',
    userId: 'user',
    operationId: 'operation',
    generation: 2,
    kind: 'transfer',
    hostId: 'host',
    instanceId: 'instance',
    expiresAt: new Date(now + 45000).toISOString(),
  };
  // Synthetic AV process boundary only; current production readers validate every field.
  // This is not an assertion that a real engine ran or approved a document.
  const subject = {
    tenantId: 'tenant',
    userId: 'user',
    operationId: 'operation',
    transferGeneration: 2,
    mediaType: 'text/plain',
    bytes: payload.length,
    sha256: integrity.sha256,
  };
  const antivirus = {
    version: 1 as const,
    slot: 'fixture-av',
    podUid: 'fixture-pod',
    runtimeImage: 'fixture/av@sha256:' + 'd'.repeat(64),
    sourceRevision: 'e'.repeat(40),
    engineArtifactSha256: 'f'.repeat(64),
    profileSha256: 'a'.repeat(64),
    signatureManifestSha256: 'b'.repeat(64),
    signatureVerificationSha256: 'c'.repeat(64),
    dailyDatabaseVersion: 1,
    dailyPublishedAt: new Date(now - 10000).toISOString(),
    original: {
      id: '33333333-3333-4333-8333-333333333333',
      pid: 1234,
      startTicks: '5678',
      bootId: '44444444-4444-4444-8444-444444444444',
      configurationSha256: 'd'.repeat(64),
    },
    subject,
    expiresAt: new Date(now + 60000).toISOString(),
  };
  const execution = {
    version: 3 as const,
    antivirus,
    custody: { kind: 'none' as const },
    attemptId: 'operation.2',
    instanceId: '11111111-1111-4111-8111-111111111111',
    executionId: '22222222-2222-4222-8222-222222222222',
    expiresAt: new Date(now + 60000).toISOString(),
  };
  const approval: UploadSecurityApproval = {
    version: 2,
    antivirus: {
      custody: antivirus,
      engineVersion: 'fixture-1',
      readyObservedAt: new Date(now - 1000).toISOString(),
      cleanAt: new Date(now).toISOString(),
    },
    decision: 'approved',
    policySha256: policy,
    subject: {
      tenantId: 'tenant',
      userId: 'user',
      operationId: 'operation',
      transferGeneration: 2,
      mediaType: 'text/plain',
      bytes: payload.length,
      sha256: integrity.sha256,
    },
    scannerVersion: 'inert-fixture',
    checkedAt: new Date(now).toISOString(),
    coverage: { complete: true, pages: 1, parts: 1 },
  };
  let stored = {
    _id: 'operation',
    tenantId: 'tenant',
    userId: 'user',
    generation: 2,
    attemptGeneration: 2,
    workerGeneration: 2,
    slot: 'transfer',
    state: 'transferring',
    worker: { hostId: 'host', instanceId: 'instance' },
    leaseExpiresAt: now + 45000,
    declaredBytes: payload.length,
    mediaType: 'text/plain',
    securityExecution: execution,
    securitySettlement: {
      execution,
      writerStopped: true,
      transientDataRemoved: true,
      antivirusReceipt: {
        custody: antivirus,
        state: 'retired',
        originalProcessJoined: true,
        ownedTransientDataRemoved: true,
      },
    },
    writerStopped: true,
    stagingHeld: false,
    cleanupPending: true,
    originalBytes: payload.length,
    textBytes: 0,
    recordBytes: 65536,
    pendingBytes: payload.length,
    revision: 1,
    cleanupCustody: { version: 1 },
  } as StoredUpload;
  const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const query = (read: () => unknown) => {
    const q = {
      session: () => q,
      maxTimeMS: () => q,
      lean: async () => copy(read()),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(copy(read())).then(resolve),
    };
    return q;
  };
  const errors: string[] = [];
  let lock = Promise.resolve();
  const global = {
    reconciled: true,
    originalBytes: payload.length,
    objectBytes: payload.length,
    textBytes: 0,
    revision: 1,
  };
  const store = {
    Operation: {
      findById: () => query(() => stored),
      findOne: (where: Record<string, unknown>) =>
        query(() =>
          where._id === stored._id &&
          where.tenantId === stored.tenantId &&
          where.userId === stored.userId
            ? stored
            : null,
        ),
    },
    save: jest.fn(async (row: StoredUpload) => {
      validateNasUploadState(row);
      stored = copy(row);
    }),
    transaction: async <T>(
      run: (session: unknown, counters: unknown) => Promise<T>,
    ): Promise<T> => {
      const previous = lock;
      let release!: () => void;
      lock = new Promise<void>((r) => {
        release = r;
      });
      await previous;
      try {
        return await run({ fixture: true }, global);
      } catch (error) {
        errors.push(
          error instanceof Error
            ? (error.stack ?? error.message).split('\n').slice(0, 5).join('\n')
            : 'unknown external transaction failure',
        );
        throw error;
      } finally {
        release();
      }
    },
    releaseQueue: jest.fn(),
  };
  // The facade replaces only Mongo persistence, as in the repository's own NAS contract suite.
  const context = {
    store,
    securityPolicySha256: policy,
    ...(av ? { nasAntivirusAdmission: () => true } : {}),
    mongoose: { mongo, models: { File: { exists: () => query(() => null) } } },
  } as unknown as UploadManagementContext;
  const transitions = createUploadCleanupTransitions(store as never);
  context.applyCleanup = transitions.applyCleanup;
  const actual = createUploadNasMethods(context);
  // Jest's native structuredClone returns foreign-realm DTOs. Normalize only the
  // authentic producer's returned own-data snapshot; never change its observer capabilities.
  // Native production runs these modules in one realm; all validation/transactions remain real.
  const repository: UploadNasMethods = {
    ...actual,
    dispatchNasOriginalWrite(lease, input, integrity, approval, at, dispatch) {
      return actual.dispatchNasOriginalWrite(
        lease,
        input,
        integrity,
        approval,
        at,
        (binding, observer) => dispatch(copy(binding), observer),
      );
    },
    dispatchNasCleanup(principal, id, dispatch, claim) {
      return actual.dispatchNasCleanup(
        principal,
        id,
        (binding, observer) => dispatch(copy(binding), observer),
        claim,
      );
    },
    observeNasCleanup(principal, id, observe) {
      return actual.observeNasCleanup(principal, id, (binding) => observe(copy(binding)));
    },
  };
  const client = createNasS3Client({
    backend,
    bucket: 'cortex-files',
    region: 'test',
    endpoint: 'https://nas.invalid:9443',
    credentials: { accessKeyId: 'synthetic-access', secretAccessKey: 'synthetic-secret' },
    trust: { mode: 'ca-hostname' },
    requestTimeoutMs: 1000,
  });
  clients.push(client);
  const transport = mockClient(client);
  const events: string[] = [];
  transport.on(PutObjectCommand).callsFake(async (input) => {
    events.push('PUT');
    expect(input.IfMatch).toBeUndefined();
    expect(input.IfNoneMatch).toBeUndefined();
    expect(input.Key).toBe(stored.writeBinding!.key);
    if (!(input.Body instanceof Readable)) throw new Error('Expected actual adapter stream');
    const chunks: Buffer[] = [];
    for await (const chunk of input.Body) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(payload);
    return { $metadata: { httpStatusCode: 200, requestId: 'original' }, ETag: 'opaque' };
  });
  transport.on(GetObjectCommand).callsFake(async () => {
    events.push('GET');
    expect(stored.originalWrite?.state).toBe('acknowledged');
    return {
      $metadata: { httpStatusCode: 200 },
      ContentLength: payload.length,
      Body: sdkStreamMixin(Readable.from([payload])),
    };
  });
  transport.on(DeleteObjectCommand).resolves({ $metadata: { httpStatusCode: 204 } });
  transport
    .on(HeadObjectCommand)
    .rejects(Object.assign(new Error('missing'), { $metadata: { httpStatusCode: 404 } }));
  const adapter = createNasS3Storage({ client, repository, assertWriteSafe: () => undefined });
  const input = () => ({
    bindWrite: jest.fn(),
    lease,
    filename: 'private.txt',
    mediaType: 'text/plain',
    bytes: payload.length,
    integrity,
    securityApproval: approval,
    body: Readable.from([payload]),
    signal: new AbortController().signal,
  });
  return {
    adapter,
    errors,
    repository,
    transport,
    events,
    input,
    row: () => stored,
    replaceRow: (value: StoredUpload) => {
      stored = copy(value);
    },
    context,
    store,
    global,
    task: (): import('librechat-data-provider').UploadCleanupTask => ({
      principal,
      operationId: stored._id,
      generation: stored.generation,
      attemptGeneration: stored.attemptGeneration ?? undefined,
      state: stored.state,
      writeBinding: copy(stored.writeBinding!),
      original: stored.original,
      writerStopped: true,
      localCopiesAbsent: true,
    }),
    client,
    cancel: () => transitions.terminal(stored, global as never, 'cancelled', 'cancelled'),
  };
}

// The following facade models only Mongo's bounded predicates/atomic updates. Production
// Housekeeping issues the claim and every File/Upload validator still consumes that claim.
// The following facade models only Mongo's bounded predicates/atomic updates. Production
// Housekeeping issues the claim and every File/Upload validator still consumes that claim.
import { Schema } from 'mongoose';
import { createHousekeepingStore } from '../../../data-schemas/src/methods/housekeepingStore';
import { createUploadFileCleanupOwner } from '../../../data-schemas/src/methods/uploadFileCleanup';
import { createFileCleanupLifecycleMethods } from '../../../data-schemas/src/methods/fileCleanupLifecycle';
import { createFileCleanupClaimMethods } from '../../../data-schemas/src/methods/fileCleanupClaim';
import { initialFileRetentionActivity } from '../../../data-schemas/src/methods/fileActivityTransition';
import { uploadFileCleanupBinding } from '../../../data-schemas/src/methods/uploadFileCleanupBinding';
import type { HousekeepingWork, JobPhase } from '../../../data-schemas/src/types/housekeeping';
import type { HousekeepingJobRecord } from '../../../data-schemas/src/models/housekeepingJob';
import type { FileCleanupProgress } from '../../../data-schemas/src/types/fileCleanup';

const clone = <T>(v: T): T => {
  if (v instanceof Date) return new Date(v) as T;
  if (Array.isArray(v)) return v.map(clone) as T;
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.entries(v).map(([k, value]) => [k, clone(value)])) as T;
  return v;
};
type Predicate = Record<string, unknown>;
type Update = {
  $set?: Predicate;
  $inc?: Record<string, number>;
  $setOnInsert?: HousekeepingJobRecord;
};
type Pipeline = { $set: Predicate }[];
type FixtureFile = Predicate & {
  retentionCleanup?: FileCleanupProgress;
  deletionCompletedAt?: Date;
};
function record(value: unknown): Predicate {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof Date)
    throw Error('Unsupported bounded Mongo record');
  return value as Predicate;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw Error('Unsupported bounded Mongo array');
  return value;
}
function comparable(value: unknown): string | number {
  if (value instanceof Date) return value.getTime();
  if (value == null || typeof value === 'boolean') return Number(value);
  if (typeof value !== 'string' && typeof value !== 'number')
    throw Error('Unsupported bounded Mongo comparison');
  return value;
}
const at = (v: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((a, p) => (a == null ? undefined : record(a)[p]), v);
function set(v: object, path: string, value: unknown) {
  const keys = path.split('.');
  const last = keys.pop()!;
  let target = record(v);
  for (const key of keys) target = record((target[key] ??= {}));
  target[last] = clone(value);
}
function expression(v: unknown, row: object): unknown {
  if (v === '$$NOW') return new Date();
  if (typeof v === 'string' && v.startsWith('$')) return at(row, v.slice(1));
  if (!v || typeof v !== 'object' || v instanceof Date) return v;
  const fields = record(v);
  if ('$literal' in fields) return clone(fields.$literal);
  if ('$add' in fields)
    return array(fields.$add).reduce<number>((n, x) => n + Number(expression(x, row)), 0);
  for (const key of ['$gt', '$lte'])
    if (key in fields) {
      const [a, b] = array(fields[key]).map((x) => comparable(expression(x, row)));
      return key === '$gt' ? a > b : a <= b;
    }
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expression(x, row)]));
}
function matches(row: unknown, where: Predicate): boolean {
  if (!row) return false;
  return Object.entries(where).every(([key, expected]) => {
    if (key === '$and') return array(expected).every((x) => matches(row, record(x)));
    if (key === '$expr') return expression(expected, record(row)) === true;
    const value = at(row, key);
    if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
      const condition = record(expected);
      if ('$lt' in condition) return comparable(value) < comparable(condition.$lt);
      if ('$lte' in condition) return comparable(value) <= comparable(condition.$lte);
      if ('$in' in condition) return array(condition.$in).includes(value);
      if ('$exists' in condition) return (value !== undefined) === condition.$exists;
    }
    if (expected === null) return value == null;
    return JSON.stringify(value) === JSON.stringify(expected);
  });
}
function apply(row: object, update: Update | Pipeline) {
  if (Array.isArray(update)) {
    for (const stage of update) {
      const next = Object.entries(stage.$set).map(
        ([key, value]) => [key, expression(value, row)] as const,
      );
      for (const [key, value] of next) set(row, key, value);
    }
  } else {
    for (const [key, value] of Object.entries(update.$set ?? {})) set(row, key, value);
    for (const [key, value] of Object.entries(update.$inc ?? {})) {
      const current = at(row, key);
      if (typeof current !== 'number') throw Error('Unsupported bounded Mongo increment');
      set(row, key, current + Number(value));
    }
  }
}
function query<T>(read: () => T) {
  const q = {
    session: () => q,
    maxTimeMS: () => q,
    select: () => q,
    setOptions: () => q,
    lean: async () => clone(read()),
    then: (resolve: (value: T) => unknown) => Promise.resolve(clone(read())).then(resolve),
  };
  return q;
}

export async function housekeepingFixture<T extends boolean>(
  f: ReturnType<typeof nasFixture>,
  accepted: T,
) {
  const jobs: HousekeepingJobRecord[] = [];
  let file: FixtureFile | null = null;
  let pendingTarget = false;
  const client = {};
  const session = {
    client,
    inTransaction: () => true,
    endSession: async () => {},
    withTransaction: async <T>(run: () => Promise<T>): Promise<T> => {
      const oldFile = clone(file),
        oldJobs = clone(jobs),
        oldRow = clone(f.row()),
        oldGlobal = clone(f.global);
      try {
        return await run();
      } catch (e) {
        file = oldFile;
        jobs.splice(0, jobs.length, ...oldJobs);
        f.replaceRow(oldRow);
        Object.assign(f.global, oldGlobal);
        throw e;
      }
    },
  };
  const collection = {
    find: (where: Predicate) => ({
      sort: () => ({
        limit: () => ({ toArray: async () => clone(jobs.filter((r) => matches(r, where))) }),
      }),
    }),
    findOne: async (where: Predicate) => clone(jobs.find((r) => matches(r, where)) ?? null),
    aggregate: (stages: { $match: Predicate }[]) => ({
      next: async () => {
        const row = jobs.find((r) => matches(r, stages[0].$match));
        return row ? { ...clone(row), ownerNow: new Date() } : null;
      },
    }),
    updateOne: async (
      where: Predicate,
      update: Update | Pipeline,
      options?: { upsert?: boolean },
    ) => {
      const row = jobs.find((r) => matches(r, where));
      if (row) apply(row, update);
      else if (options?.upsert) {
        if (Array.isArray(update) || !update.$setOnInsert)
          throw Error('Missing bounded Mongo insert');
        jobs.push(clone(update.$setOnInsert));
      }
      return { acknowledged: true, matchedCount: row ? 1 : 0, modifiedCount: row ? 1 : 0 };
    },
    findOneAndUpdate: async (where: Predicate, update: Update | Pipeline) => {
      const row = jobs.find((r) => matches(r, where));
      if (!row) return null;
      apply(row, update);
      row.claim!.leaseUntil = new Date(row.claim!.leaseUntil);
      return clone(row);
    },
  };
  const models = {
    HousekeepingJob: { collection, init: async () => {} },
    File: {
      findOne: (where: Predicate) => query(() => (matches(file, where) ? file : null)),
      exists: (where: Predicate) =>
        query(() => (matches(file, where) ? { _id: 'file-row' } : null)),
      updateOne: async (where: Predicate, update: Update | Pipeline) => {
        const yes = matches(file, where);
        if (yes && file) apply(file, update);
        return { acknowledged: true, matchedCount: yes ? 1 : 0 };
      },
    },
    FileCleanupTarget: {
      exists: () => query(() => (pendingTarget ? { _id: 'owned-pending-target' } : null)),
    },
    UploadOperation: f.store.Operation,
    UploadCounter: { findById: () => query(() => ({ _id: 'global', value: f.global })) },
  };
  Object.assign(f.context.mongoose.models, models);
  Object.assign(f.context.mongoose, {
    Schema,
    startSession: async () => session,
    connection: {
      db: { command: async () => ({ localTime: new Date() }) },
      getClient: () => client,
    },
  });
  Object.assign(f.store, { Counter: models.UploadCounter });
  // NAS and File share this external Mongo session; otherwise the real HK owner correctly
  // refuses its cross-owner transaction. A rejected transaction restores every modeled row.
  const transaction = f.store.transaction.bind(f.store);
  f.store.transaction = (run) =>
    session.withTransaction(() => transaction((_session, counters) => run(session, counters)));

  const store = createHousekeepingStore(f.context.mongoose);
  let work: HousekeepingWork;
  const revocationId = 'revocation';
  if (accepted) {
    const row = f.row();
    row.acceptedAt = Date.now() - 10000;
    row.fileId = row._id;
    row.state = 'deleted';
    row.actualBytes = row.original!.bytes;
    const binding = uploadFileCleanupBinding(row)!;
    file = {
      user: row.userId,
      tenantId: row.tenantId,
      file_id: row._id,
      uploadOperationId: row._id,
      bytes: row.original!.bytes,
      source: row.original!.source,
      storageKey: row.original!.storageKey,
      retentionAcceptedAt: new Date(row.acceptedAt),
      expiredAt: new Date(1000),
      retentionRevision: 0,
      retentionRevocationId: revocationId,
      deletionRequestedAt: new Date(2000),
      retentionActivity: initialFileRetentionActivity(new Date(1000), new Date(0), 'complete'),
    };
    work = {
      handler: 'file.cleanup',
      subject: { tenantId: row.tenantId, ownerUserId: row.userId, fileId: row._id },
      deadlineGeneration: 0,
      revocationId,
    };
    // Initialized below after the real store creates this execution and its real claim.
    if (!binding) throw new Error('No authentic NAS File binding');
  } else
    work = {
      handler: 'upload.cleanup',
      subject: { tenantId: principal.tenantId, ownerUserId: principal.userId },
      operationId: f.row()._id,
      cleanupGeneration: f.row().generation,
      attemptGeneration: f.row().attemptGeneration!,
    };
  await store.project(work, new Date(0), session as never);
  const claim = (await store.claimNext(work.handler, {
    podUid: 'hk-pod',
    incarnation: 'boot',
    source: 'hk-source',
    hostId: 'host',
  }))!;
  if (!claim) throw new Error('Real Housekeeping claim unavailable');
  if (accepted) {
    const binding = uploadFileCleanupBinding(f.row());
    if (!binding) throw new Error('No authentic NAS File binding');
    const phases: JobPhase[] = [
      'awaiting_deadline',
      'revoked',
      'capturing_generations',
      'settling_generations',
      'purging_derivatives',
    ];
    for (let i = 1; i < phases.length; i++) {
      if (
        !(await store.advance(
          claim,
          { revision: i - 1, phase: phases[i - 1] },
          { phase: phases[i], code: 'progress' },
          session as never,
        ))
      )
        throw new Error('Real Housekeeping advance refused');
    }
    file!.retentionCleanup = {
      schema: 1,
      jobId: claim.jobId,
      executionId: claim.executionId,
      revocationId,
      capture: { complete: true, cursor: null, recoveryUnresolved: false },
      generationReceiptRef: 'generation:complete',
      lifecycle: {
        upload: binding,
        derivatives: {
          retrieval: 'complete',
          checkpoints: 'complete',
          messages: 'complete',
          messageCursor: null,
        },
        storage: null,
        contentPrepared: false,
        completionRef: null,
      },
    };
  }
  const unavailable = jest.fn(async () => {
    throw Error('External File retention owner unavailable');
  });
  const retention = { settleFileSourceDeletionInSession: unavailable };
  f.context.lifecycle = retention as never;
  const life = createFileCleanupLifecycleMethods(
    f.context.mongoose,
    store,
    createUploadFileCleanupOwner(f.context.mongoose),
    retention,
    {
      purgeRetrieval: unavailable,
      purgeCheckpoints: unavailable,
      redactFileSourceContent: unavailable,
    },
  );
  const entry = createFileCleanupClaimMethods(f.context.mongoose, store, {
    revokeExpiredManagedUpload: unavailable,
  });
  return {
    claim,
    store,
    life,
    entry,
    file: () => file as T extends true ? FixtureFile : FixtureFile | null,
    jobs,
    unavailable,
    pendingTarget: (value: boolean) => {
      pendingTarget = value;
    },
    custody: (): FileCleanupProgress => file!.retentionCleanup!,
  };
}
