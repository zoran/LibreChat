import mongoose from 'mongoose';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  createFileRetrievalOperationOwner,
  createModels,
  runAsSystem,
} from '@librechat/data-schemas';
import {
  buildManagedRevision,
  canonicalManagedJson,
  validateManagedCapability,
} from 'librechat-data-provider';
import type { FileRetrievalPolicySnapshot, FileRetrievalOriginal } from '@librechat/data-schemas';
import type { ManagedCapability, ManagedRetrievalState } from 'librechat-data-provider';
import type { ManagedFilePurge, TrustedManagedFileConfiguration } from './managed';
import {
  assertManagedFileRetrievalRelease,
  createManagedFileRetrieval,
  createManagedFilePurge,
  managedFileRetrievalPath,
} from './managed';
import fixture from '../../../../data-provider/src/__fixtures__/managed-retrieval-v1.json';
import { createManagedRagClient } from './transport';

jest.mock('./transport', () => ({
  createManagedRagClient: jest.fn(() => {
    throw new Error('Disabled retrieval must never open a transport');
  }),
}));

beforeEach(() => {
  jest
    .mocked(createManagedRagClient)
    .mockReset()
    .mockImplementation(() => {
      throw new Error('Unconfigured test transport');
    });
});
afterEach(() => jest.restoreAllMocks());

/** Disabled composition must not acquire a backend or operation owner. */
it.each([undefined, { extractionPolicySha256: 'a'.repeat(64) }])(
  'does not construct retrieval without its admitted binding (%s)',
  async (trustedFile) => {
    const operations = jest.fn(() => {
      throw new Error('Disabled retrieval must never construct an operation owner');
    });
    const sources = {
      authorize: jest.fn(),
      resolve: jest.fn(),
      revalidate: jest.fn(),
    };
    const runAsSystem = jest.fn(() => {
      throw new Error('Disabled retrieval must never start a system operation');
    });
    expect(
      await createManagedFileRetrieval({
        trustedFile,
        sources,
        operations,
        runAsSystem,
      }),
    ).toBeUndefined();
    expect(operations).not.toHaveBeenCalled();
    expect(createManagedRagClient).not.toHaveBeenCalled();
    expect(runAsSystem).not.toHaveBeenCalled();
    expect(sources.authorize).not.toHaveBeenCalled();
    expect(sources.resolve).not.toHaveBeenCalled();
  },
);

it('composition review selects the existing single- and multi-File query routes', () => {
  expect(managedFileRetrievalPath('query', 1)).toBe('/query');
  expect(managedFileRetrievalPath('query', 2)).toBe('/query_multiple');
  expect(managedFileRetrievalPath('query', 32)).toBe('/query_multiple');
  expect(createManagedRagClient).not.toHaveBeenCalled();
});

it.each(['original deadline', 'shorter issued capability'])(
  'composition review rejects release when the final read crosses the %s',
  async (boundary) => {
    const capability = JSON.parse(JSON.stringify(fixture.capability)) as ManagedCapability;
    if (boundary === 'shorter issued capability') capability.exp = capability.iat + 20;
    const original = JSON.parse(JSON.stringify(capability));
    const authority = {
      ...fixture.capabilityContext,
      purpose: 'query' as const,
      // The File remains live; neither source revocation nor source expiry explains rejection.
      sourceExpiresAt: capability.workDeadline + 600,
    };
    let milliseconds = (capability.exp - 1) * 1000;
    jest.spyOn(Date, 'now').mockImplementation(() => milliseconds);
    const signal = new AbortController().signal;
    await expect(
      assertManagedFileRetrievalRelease(capability, async () => authority, signal),
    ).resolves.toBeUndefined();
    const finalRead = jest.fn(async () => {
      await Promise.resolve();
      milliseconds = capability.exp * 1000;
      return authority;
    });
    await expect(assertManagedFileRetrievalRelease(capability, finalRead, signal)).rejects.toThrow(
      'Capability scope or deadline mismatch',
    );
    expect(finalRead).toHaveBeenCalledTimes(1);
    expect(capability).toEqual(original);
    expect(createManagedRagClient).not.toHaveBeenCalled();
  },
);

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const fingerprint = (value: unknown) => digest(canonicalManagedJson(value));
const policy = (): FileRetrievalPolicySnapshot => {
  const content = {
    backendIdentity: fixture.obligation.backendIdentity,
    routePolicySha256: '1'.repeat(64),
    rankingPolicySha256: '2'.repeat(64),
    indexGeneration: fixture.key.indexGeneration,
    writerEpoch: 1,
    provenanceSha256: '3'.repeat(64),
  };
  return {
    version: 1,
    source: { provenanceSha256: content.provenanceSha256 },
    content,
    purge: [copy(content)],
  };
};
const binding = (snapshot = policy()): TrustedManagedFileConfiguration => ({
  extractionPolicySha256: fixture.revision.extractionPolicySha256,
  retrieval: {
    profile: copy(fixture.indexProfile) as NonNullable<
      TrustedManagedFileConfiguration['retrieval']
    >['profile'],
    policySnapshot: snapshot,
    transport: {
      backendIdentity: snapshot.content.backendIdentity,
      url: 'https://retrieval.invalid',
      serverCertificateSha256: '6'.repeat(64),
    },
  },
});
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

it('full Retrieval startup rejects the original pre-abort before owner or transport acquisition', async () => {
  const controller = new AbortController();
  const reason = new Error('Original web startup cancelled');
  controller.abort(reason);
  const operations = jest.fn(() => {
    throw new Error('Owner must not be acquired');
  });
  await expect(
    createManagedFileRetrieval({
      trustedFile: binding(),
      operations,
      runAsSystem,
      sources: { authorize: jest.fn(), resolve: jest.fn(), revalidate: jest.fn() },
      signal: controller.signal,
    }),
  ).rejects.toBe(reason);
  expect(operations).not.toHaveBeenCalled();
  expect(createManagedRagClient).not.toHaveBeenCalled();
});

it('full Retrieval startup retains held initialization through original abort without opening transport', async () => {
  const entered = deferred<void>();
  const release = deferred<void>();
  const controller = new AbortController();
  const reason = new Error('Original web startup cancelled');
  const initialize = jest.fn(async () => {
    entered.resolve();
    await release.promise;
  });
  const operations = jest.fn(() => ({
    initialize,
    admit: jest.fn(),
    lookup: jest.fn(),
    admitPurge: jest.fn(),
    acknowledgeIndex: jest.fn(),
    acknowledgePurge: jest.fn(),
  }));
  const original = createManagedFileRetrieval({
    trustedFile: binding(),
    operations,
    runAsSystem,
    sources: { authorize: jest.fn(), resolve: jest.fn(), revalidate: jest.fn() },
    signal: controller.signal,
  });
  let settled = false;
  void original.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  try {
    await entered.promise;
    controller.abort(reason);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(createManagedRagClient).not.toHaveBeenCalled();
  } finally {
    release.resolve();
  }
  await expect(original).rejects.toBe(reason);
  expect(createManagedRagClient).not.toHaveBeenCalled();
});

it.each([
  'absent',
  'missing retrieval',
  'profile',
  'generation',
  'extraction',
  'backend',
  'provenance',
  'purge',
])('purge construction rejects %s binding before owner or client acquisition', async (kind) => {
  const trusted = binding();
  if (kind === 'profile') Object.assign(trusted.retrieval!.profile, { dimensions: 0 });
  if (kind === 'generation')
    trusted.retrieval!.policySnapshot.content.indexGeneration = '0'.repeat(64);
  if (kind === 'extraction') trusted.extractionPolicySha256 = 'invalid';
  if (kind === 'backend') trusted.retrieval!.transport.backendIdentity = 'another-backend';
  if (kind === 'provenance')
    trusted.retrieval!.policySnapshot.source.provenanceSha256 = '0'.repeat(64);
  if (kind === 'purge') trusted.retrieval!.policySnapshot.purge = [];
  let trustedFile: TrustedManagedFileConfiguration | undefined = trusted;
  if (kind === 'absent') trustedFile = undefined;
  else if (kind === 'missing retrieval') trustedFile = {};
  const operations = jest.fn(() => {
    throw new Error('No operation owner expected');
  });
  await expect(
    createManagedFilePurge({
      trustedFile: trustedFile as TrustedManagedFileConfiguration,
      operations,
      runAsSystem,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow();
  expect(operations).not.toHaveBeenCalled();
  expect(createManagedRagClient).not.toHaveBeenCalled();
});

it.each(['retrieval', 'purge'] as const)(
  'constructs %s from its admitted policy without a per-File inventory receipt',
  async (kind) => {
    const initialize = jest.fn(async () => undefined);
    const operations = jest.fn(() => ({
      initialize,
      admit: jest.fn(),
      lookup: jest.fn(),
      admitPurge: jest.fn(),
      acknowledgeIndex: jest.fn(),
      acknowledgePurge: jest.fn(),
    }));
    const close = jest.fn();
    jest.mocked(createManagedRagClient).mockReturnValue({ invoke: jest.fn(), close });
    const trustedFile = binding();
    const resource =
      kind === 'purge'
        ? await createManagedFilePurge({
            trustedFile,
            operations,
            runAsSystem,
            signal: new AbortController().signal,
          })
        : await createManagedFileRetrieval({
            trustedFile,
            operations,
            runAsSystem,
            sources: { authorize: jest.fn(), resolve: jest.fn(), revalidate: jest.fn() },
          });
    try {
      expect(resource).toBeDefined();
      expect(initialize).toHaveBeenCalledTimes(1);
      expect(operations).toHaveBeenCalledWith(trustedFile.retrieval!.policySnapshot);
      expect(createManagedRagClient).toHaveBeenCalledTimes(1);
    } finally {
      await resource!.close();
    }
    expect(close).toHaveBeenCalledTimes(1);
  },
);

it.each(['aborted', 'missing'])(
  'purge construction rejects %s acquisition signal before resources',
  async (kind) => {
    const controller = new AbortController();
    const reason = new Error('Process already shutting down');
    controller.abort(reason);
    const operations = jest.fn(() => {
      throw new Error('No operation owner expected');
    });
    const opening = createManagedFilePurge({
      trustedFile: binding(),
      operations,
      runAsSystem,
      signal: kind === 'aborted' ? controller.signal : (undefined as unknown as AbortSignal),
    });
    if (kind === 'aborted') await expect(opening).rejects.toBe(reason);
    else await expect(opening).rejects.toThrow('Managed retrieval unavailable');
    expect(operations).not.toHaveBeenCalled();
    expect(createManagedRagClient).not.toHaveBeenCalled();
  },
);

/** Real Mongo/File originals and ACK transactions; only the external backend boundary is simulated. */
describe('cleanup composition with the actual File operation owner', () => {
  const db = new mongoose.Mongoose();
  const owner = { tenantId: 'retrieval-cleanup', userId: new mongoose.Types.ObjectId().toString() };
  const fileId = 'cleanup-source';
  let mongo: MongoMemoryReplSet;
  let directory: string;
  const previousSecurityPolicy = process.env.UPLOAD_SECURITY_POLICY_SHA256;
  let resources: ManagedFilePurge[] = [];
  type Operations = ReturnType<typeof createFileRetrievalOperationOwner>;
  type Invoke = Parameters<ReturnType<typeof createManagedRagClient>['invoke']>[0];
  let invoke: jest.Mock<Promise<unknown>, [Invoke]>;
  let close: jest.Mock;
  let registeredMongo: {
    kind: string;
    pid: number;
    start: string;
    port?: number;
    dbPath?: string;
  }[] = [];
  const controller = () => new AbortController();
  const readFile = () =>
    runAsSystem(async () =>
      db.models.File.findOne({ file_id: fileId })
        .select('+managedRetrieval +retrievalCreation')
        .lean<{ managedRetrieval: ManagedRetrievalState }>(),
    );
  function registerMongo(status: 'running' | 'settled') {
    if (!process.env.RETENTION_RUN_KEY) return;
    if (status === 'running')
      registeredMongo = mongo.servers.flatMap((server) => {
        const info = server.instanceInfo;
        return (
          [
            ['mongod', info?.instance.mongodProcess?.pid],
            ['killer', info?.instance.killerProcess?.pid],
          ] as const
        ).flatMap(([kind, pid]) =>
          typeof pid === 'number'
            ? [
                {
                  kind,
                  pid,
                  start: readFileSync(`/proc/${pid}/stat`, 'utf8')
                    .split(')')[1]
                    .trim()
                    .split(' ')[19],
                  port: info?.port,
                  dbPath: kind === 'mongod' ? info?.dbPath : undefined,
                },
              ]
            : [],
        );
      });
    execFileSync('python3', [
      `${process.env.RETENTION_RUN_SCOPE}/runner/register-mongo.py`,
      status,
      JSON.stringify(registeredMongo),
    ]);
  }
  beforeAll(async () => {
    process.env.UPLOAD_SECURITY_POLICY_SHA256 = fixture.revisionInput.approval.policySha256;
    directory = await mkdtemp(join(tmpdir(), 'retrieval-cleanup-'));
    mongo = new MongoMemoryReplSet({
      binary: {
        version: process.env.MONGOMS_VERSION ?? '7.0.43',
        ...(process.env.MONGOMS_SYSTEM_BINARY
          ? { systemBinary: process.env.MONGOMS_SYSTEM_BINARY }
          : {}),
      },
      instanceOpts: [{ dbPath: directory }],
      replSet: { count: 1, storageEngine: 'wiredTiger' },
    });
    try {
      await mongo.start();
    } finally {
      registerMongo('running');
    }
    await db.connect(mongo.getUri('retrieval-cleanup'), { serverSelectionTimeoutMS: 5000 });
    createModels(db);
    await Promise.all(Object.values(db.models).map((model) => model.init()));
  }, 30_000);
  afterAll(async () => {
    try {
      try {
        await db.disconnect();
      } finally {
        if (mongo) {
          await mongo.stop();
          registerMongo('settled');
        }
        if (directory) await rm(directory, { recursive: true, force: true });
      }
    } finally {
      if (previousSecurityPolicy === undefined) delete process.env.UPLOAD_SECURITY_POLICY_SHA256;
      else process.env.UPLOAD_SECURITY_POLICY_SHA256 = previousSecurityPolicy;
    }
  });
  beforeEach(async () => {
    await runAsSystem(async () => db.models.File.deleteMany({}));
    if (db.models.FileRetrievalOperation) await db.models.FileRetrievalOperation.deleteMany({});
    resources = [];
    close = jest.fn();
    invoke = jest.fn(async (input: Invoke) => {
      const authority = await input.authorize();
      validateManagedCapability(input.capability, {
        ...authority,
        now: Math.floor(Date.now() / 1000),
      });
      input.signal?.throwIfAborted();
      const body = input.body as {
        purgeOperationId: string;
        keys: Array<typeof fixture.key>;
        writerEpoch: number;
      };
      const payload = {
        version: 1 as const,
        purgeOperationId: body.purgeOperationId,
        keys: body.keys,
        backendIdentity: authority.backendIdentity,
        fenceEpoch: body.writerEpoch + 1,
        state: 'purged' as const,
        remainingChunks: 0 as const,
        activeWriters: 0 as const,
        completedAt: Math.floor(Date.now() / 1000),
      };
      return { ...payload, receiptSha256: fingerprint(payload) };
    });
    jest.mocked(createManagedRagClient).mockReturnValue({ invoke, close });
  });
  afterEach(async () => {
    await Promise.allSettled(resources.map((resource) => resource.close()));
  });

  async function seeded(snapshot = policy(), { legacyUnknown = false } = {}): Promise<Operations> {
    const now = Date.now();
    const input = copy(fixture.revisionInput);
    input.owner = owner;
    input.fileId = fileId;
    input.operationId = fileId;
    input.approval.subject.tenantId = owner.tenantId;
    input.approval.subject.userId = owner.userId;
    input.approval.subject.operationId = fileId;
    const revision = buildManagedRevision(
      input as Parameters<typeof buildManagedRevision>[0],
      digest,
    );
    await runAsSystem(async () =>
      db.models.File.create({
        file_id: fileId,
        uploadOperationId: fileId,
        user: owner.userId,
        tenantId: owner.tenantId,
        bytes: 46,
        filename: 'source.txt',
        filepath: 'fixture/source',
        type: 'text/plain',
        status: 'ready',
        source: 's3',
        storageKey: `t/${owner.tenantId}/managed-uploads/${owner.userId}/${fileId}.1__original`,
        securityApproval: input.approval,
        retentionRevision: 0,
        retentionAcceptedAt: new Date(now - 1000),
        expiredAt: new Date(now + 3_600_000),
        ...(legacyUnknown
          ? {}
          : {
              retrievalCreation: {
                version: 1,
                owner,
                fileId,
                acceptedAt: now - 1000,
                state: 'empty',
              },
            }),
        managedRetrieval: { version: 1, revision, inventory: 'unknown', obligations: [] },
      }),
    );
    const operations = createFileRetrievalOperationOwner(db, { policySnapshot: snapshot });
    await runAsSystem(() => operations.initialize());
    if (!legacyUnknown)
      await runAsSystem(() =>
        operations.admit({
          owner,
          fileIds: [fileId],
          purpose: 'index',
          operationId: 'original-index',
          body: { exact: 'retained original body' },
        }),
      );
    await runAsSystem(async () =>
      db.models.File.updateOne(
        { file_id: fileId },
        {
          $set: { deletionRequestedAt: new Date(), expiredAt: new Date(now - 1) },
        },
      ),
    );
    return operations;
  }
  async function open(operations: Operations, trustedFile = binding()) {
    const result = await createManagedFilePurge({
      trustedFile,
      operations: () => operations,
      runAsSystem,
      signal: controller().signal,
    });
    resources.push(result);
    return result;
  }
  const originals = () =>
    db.models.FileRetrievalOperation.find({ 'original.purpose': 'purge' }).lean();

  it('purges revoked expired File through actual ACK and reenters without replacing originals or redispatching', async () => {
    const operations = await seeded();
    const resource = await open(operations);
    expect(Object.keys(resource).sort()).toEqual(['close', 'purge']);
    await resource.purge(owner, [fileId, fileId]);
    const records = await originals();
    expect(records).toHaveLength(1);
    expect((await readFile())!.managedRetrieval.obligations[0]).toMatchObject({
      state: 'purged',
      purgeOperationId: records[0].operationId,
    });
    await resource.purge(owner, [fileId]);
    expect(await originals()).toEqual(records);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(createManagedRagClient).toHaveBeenCalledTimes(1);
    await resource.close();
    expect(close).toHaveBeenCalledTimes(1);
    expect(() => resource.purge(owner, [fileId])).toThrow();
  });

  it('full retrieval retains the shared cleanup, lookup and maintenance lifecycle with one client', async () => {
    const operations = await seeded();
    const sources = { authorize: jest.fn(), resolve: jest.fn(), revalidate: jest.fn() };
    const trustedFile = binding();
    const opening = createManagedFileRetrieval({
      trustedFile,
      operations: () => operations,
      sources,
      runAsSystem,
    });
    trustedFile.retrieval!.transport.url = 'https://changed-after-acquisition.invalid';
    const resource = (await opening)!;
    resources.push(resource);
    await resource.purge(owner, [fileId]);
    const census = await resource.maintenance.getMaintenanceCensus(null);
    expect(census).toMatchObject({ pendingWrites: 0, complete: true });
    expect(createManagedRagClient).toHaveBeenCalledWith(binding().retrieval!.transport);
    expect(resource.lookup).toEqual(expect.any(Function));
    expect(resource.index).toEqual(expect.any(Function));
    expect(resource.query).toEqual(expect.any(Function));
    expect(sources.resolve).not.toHaveBeenCalled();
    expect(createManagedRagClient).toHaveBeenCalledTimes(1);
  });

  it('retains held initialize after acquisition abort and rejects before constructing a client', async () => {
    const operations = createFileRetrievalOperationOwner(db, { policySnapshot: policy() });
    const entered = deferred<void>();
    const release = deferred<void>();
    const initialize = operations.initialize;
    operations.initialize = async () => {
      await initialize();
      entered.resolve();
      await release.promise;
    };
    const acquisition = controller();
    const reason = new Error('Original process shutdown');
    const opening = createManagedFilePurge({
      trustedFile: binding(),
      operations: () => operations,
      runAsSystem,
      signal: acquisition.signal,
    });
    let settled = false;
    void opening
      .finally(() => {
        settled = true;
      })
      .catch(() => undefined);
    try {
      await entered.promise;
      acquisition.abort(reason);
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(createManagedRagClient).not.toHaveBeenCalled();
    } finally {
      release.resolve();
    }
    await expect(opening).rejects.toBe(reason);
    expect(createManagedRagClient).not.toHaveBeenCalled();
  });

  it('propagates the original initialize and transport construction failures without claiming an owner', async () => {
    const operations = createFileRetrievalOperationOwner(db, { policySnapshot: policy() });
    const failure = new Error('Original initialize failure');
    jest.spyOn(operations, 'initialize').mockRejectedValueOnce(failure);
    await expect(open(operations)).rejects.toBe(failure);
    expect(createManagedRagClient).not.toHaveBeenCalled();
    const materialFailure = new Error('Original transport construction failure');
    jest.mocked(createManagedRagClient).mockImplementationOnce(() => {
      throw materialFailure;
    });
    await expect(open(operations)).rejects.toBe(materialFailure);
    expect(close).not.toHaveBeenCalled();
  });

  it('holds the purge original through close and preserves pending File custody after abort', async () => {
    const operations = await seeded();
    const entered = deferred<void>();
    const release = deferred<void>();
    const originalInvoke = invoke.getMockImplementation()!;
    invoke.mockImplementationOnce(async (input) => {
      await input.authorize();
      entered.resolve();
      await release.promise;
      input.signal!.throwIfAborted();
      return originalInvoke(input);
    });
    const resource = await open(operations);
    const purging = resource.purge(owner, [fileId]);
    let settled = false;
    void purging
      .finally(() => {
        settled = true;
      })
      .catch(() => undefined);
    await entered.promise;
    const ending = controller();
    const closing = resource.close(ending.signal);
    ending.abort();
    try {
      await expect(closing).rejects.toThrow('unresolved work');
      expect(settled).toBe(false);
      expect(close).toHaveBeenCalledTimes(1);
      expect(await originals()).toHaveLength(1);
    } finally {
      release.resolve();
    }
    await expect(purging).rejects.toThrow();
    expect((await readFile())!.managedRetrieval.obligations[0].state).toBe('purge_pending');
    await expect(resource.close()).rejects.toThrow('unresolved work');
  });

  it('retains uncertainty after an actual ACK commit loses its response until authoritative reentry', async () => {
    const operations = await seeded();
    const acknowledge = operations.acknowledgePurge;
    const failure = new Error('UnknownTransactionCommitResult after actual ACK');
    jest.spyOn(operations, 'acknowledgePurge').mockImplementationOnce(async (...args) => {
      await acknowledge(...args);
      throw failure;
    });
    const resource = await open(operations);
    await expect(resource.purge(owner, [fileId])).rejects.toBe(failure);
    expect((await readFile())!.managedRetrieval.obligations[0].state).toBe('purged');
    const records = await originals();
    await resource.purge(owner, [fileId]);
    expect(await originals()).toEqual(records);
    expect(invoke).toHaveBeenCalledTimes(1);
    await expect(resource.close()).resolves.toBeUndefined();
  });

  it('keeps actual unknown legacy File inventory unresolved without deployment census authority', async () => {
    const operations = await seeded(policy(), { legacyUnknown: true });
    const resource = await open(operations);
    await expect(resource.purge(owner, [fileId])).rejects.toMatchObject({
      code: 'managed_retrieval_inventory_unresolved',
    });
    expect((await readFile())!.managedRetrieval).toMatchObject({
      inventory: 'unknown',
      obligations: [],
    });
    expect(await originals()).toHaveLength(0);
    expect(invoke).not.toHaveBeenCalled();
    await expect(resource.close()).rejects.toThrow('unresolved work');
  });

  it('preserves retained-backend originals and refuses a different pinned transport', async () => {
    const previous = policy();
    previous.content.backendIdentity = 'retained-backend';
    previous.purge = [copy(previous.content)];
    await seeded(previous);
    const current = policy();
    current.purge.push(copy(previous.content));
    const operations = createFileRetrievalOperationOwner(db, { policySnapshot: current });
    const resource = await open(operations, binding(current));
    await expect(resource.purge(owner, [fileId])).rejects.toThrow('Managed retrieval unavailable');
    const records = await originals();
    expect(records).toHaveLength(1);
    expect((records[0].original as FileRetrievalOriginal).policy.backendIdentity).toBe(
      'retained-backend',
    );
    expect(invoke).not.toHaveBeenCalled();
    expect((await readFile())!.managedRetrieval.obligations[0].state).toBe('purge_pending');
    await expect(resource.close()).rejects.toThrow('unresolved work');
  });
});
