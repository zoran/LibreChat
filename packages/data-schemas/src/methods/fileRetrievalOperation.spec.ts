import mongoose from 'mongoose';
import { createHash } from 'node:crypto';
import {
  buildManagedRevision,
  canonicalManagedJson,
  validateManagedRetrievalLookup,
} from 'librechat-data-provider';
import type { ManagedIndexReceipt } from 'librechat-data-provider';
import type { FileRetrievalOriginal, FileRetrievalPolicySnapshot } from './fileRetrievalOperation';
import fixture from '../../../data-provider/src/__fixtures__/managed-retrieval-v1.json';
import { createFileRetrievalOperationOwner } from './fileRetrievalOperation';
import { createManagedFileRetrievalInventory } from './fileRetrieval';

const now = Date.parse('2026-10-19T12:00:00Z');
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const owner = fixture.revision.owner;
const policy = {
  backendIdentity: fixture.obligation.backendIdentity,
  routePolicySha256: '1'.repeat(64),
  rankingPolicySha256: '2'.repeat(64),
  indexGeneration: fixture.obligation.key.indexGeneration,
  writerEpoch: fixture.obligation.writerEpoch + 1,
  provenanceSha256: '3'.repeat(64),
};
const request = (purpose: 'index' | 'query' = 'index') => ({
  owner,
  operationId: 'original-operation',
  purpose,
  fileIds: [fixture.revision.source.fileId],
  body: { query: 'private text is hashed only' },
});
const row = () => ({
  _id: 'file-row',
  file_id: fixture.revision.source.fileId,
  user: owner.userId,
  tenantId: owner.tenantId,
  retentionAcceptedAt: new Date(now - 1000),
  expiredAt: new Date(now + 1_000_000),
  status: 'ready',
  deletionRequestedAt: null as Date | null,
  deletionCompletedAt: null as Date | null,
  managedRetrieval: {
    version: 1,
    revision: fixture.revision,
    inventory: 'unknown',
    obligations: [] as (typeof fixture.obligation & {
      purgeOperationId?: string;
      receiptSha256?: string;
    })[],
  },
});

type FixtureRow = ReturnType<typeof row> & {
  uploadOperationId?: string;
  retrievalCreation?: ReturnType<typeof createManagedFileRetrievalInventory>;
};
type FixtureOriginal = Omit<FileRetrievalOriginal, 'version' | 'purpose' | 'sources'> & {
  version: number;
  purpose: string;
  sources: (Omit<FileRetrievalOriginal['sources'][number], 'revisions'> & {
    revisions: (typeof fixture.revision)[];
  })[];
};
type FixtureStored = {
  tenantId?: string | null;
  userId?: string;
  operationId: string;
  original: FixtureOriginal;
  indexReceipt?: ManagedIndexReceipt;
};
type FixtureOperationFilter = {
  operationId: string;
  userId: string;
  tenantId: string | null;
  'original.originalSha256'?: string;
};
type FixtureSessionOptions = { session: unknown };
type FixtureCommandOptions = FixtureSessionOptions & { signal: AbortSignal; timeoutMS: number };

/** Transaction fault fixture, not Mongo conformance evidence. Actual owner/schema/query code runs. */
function storage() {
  let rows: FixtureRow[] = [row()];
  let originals: FixtureStored[] = [];
  let stagedRows: FixtureRow[] = [];
  let stagedOriginals: FixtureStored[] = [];
  let afterCallback: (() => void) | undefined;
  let lostAck = false;
  const chain = (read: () => unknown, filter?: unknown) => ({
    cast() {
      return filter;
    },
    select() {
      return this;
    },
    session() {
      return this;
    },
    lean: async () => copy(read()),
  });
  const session = {
    endSession: jest.fn(async (_options?: { timeoutMS: number }) => {}),
    withTransaction: jest.fn(async (callback: () => Promise<void>) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        stagedRows = copy(rows);
        stagedOriginals = copy(originals);
        await callback();
        if (afterCallback) {
          const hook = afterCallback;
          afterCallback = undefined;
          hook();
          continue;
        }
        rows = stagedRows;
        originals = stagedOriginals;
        if (lostAck) {
          lostAck = false;
          throw new Error('UnknownTransactionCommitResult');
        }
        return;
      }
      throw new Error('fixture transaction retry exhausted');
    }),
  };
  const File = {
    db: { name: 'fixture' },
    collection: { name: 'files' },
    find: jest.fn((filter: unknown) => chain(() => stagedRows, filter)),
    updateOne: jest.fn(
      async (
        filter: { $and: { file_id: string }[] },
        change: { $set: Partial<FixtureRow>; $inc?: Record<string, number> },
        options: FixtureSessionOptions,
      ) => {
        expect(options.session).toBe(session);
        const id = filter.$and[1].file_id;
        const found = stagedRows.find((item) => item.file_id === id);
        if (!found) return { matchedCount: 0 };
        Object.assign(found, copy(change.$set));
        return { matchedCount: 1 };
      },
    ),
  };
  const Operation = {
    db: { name: 'fixture' },
    collection: { name: 'operations' },
    find: jest.fn((filter: unknown) => chain(() => stagedOriginals, filter)),
    init: jest.fn(async () => {}),
    updateOne: jest.fn(
      async (
        filter: FixtureOperationFilter,
        change: { $set: { indexReceipt: ManagedIndexReceipt } },
        options: FixtureSessionOptions,
      ) => {
        expect(options.session).toBe(session);
        const found = stagedOriginals.find(
          (item) =>
            item.operationId === filter.operationId &&
            item.userId === filter.userId &&
            item.tenantId === filter.tenantId &&
            item.original.originalSha256 === filter['original.originalSha256'],
        );
        if (
          !found ||
          (found.indexReceipt &&
            canonicalManagedJson(found.indexReceipt) !==
              canonicalManagedJson(change.$set.indexReceipt))
        )
          return { matchedCount: 0 };
        found.indexReceipt = copy(change.$set.indexReceipt);
        return { matchedCount: 1 };
      },
    ),
    findOne: jest.fn((filter: FixtureOperationFilter) =>
      chain(
        () =>
          stagedOriginals.find(
            (item) =>
              item.operationId === filter.operationId &&
              item.userId === filter.userId &&
              item.tenantId === filter.tenantId,
          ) ?? null,
      ),
    ),
    countDocuments: jest.fn(
      (filter: { 'original.sources.fileId': string; 'original.purpose'?: { $in: string[] } }) => ({
        session: async (actual: unknown) => {
          expect(actual).toBe(session);
          return stagedOriginals.filter(
            (item) =>
              item.original.sources.some(
                (source) => source.fileId === filter['original.sources.fileId'],
              ) &&
              (!filter['original.purpose'] ||
                filter['original.purpose'].$in.includes(item.original.purpose)),
          ).length;
        },
      }),
    ),
    create: jest.fn(async (docs: FixtureStored[], options: FixtureSessionOptions) => {
      expect(options.session).toBe(session);
      stagedOriginals.push(...copy(docs));
    }),
  };
  const command = jest.fn(
    async (
      input: {
        find: string;
        singleBatch: boolean;
        limit: number;
        filter: {
          tenantId?: string | null;
          userId?: string;
          operationId: string | { $in: string[] };
        };
      },
      options: FixtureCommandOptions,
    ) => {
      expect(options.session).toBe(session);
      expect(options.signal).toBeInstanceOf(AbortSignal);
      expect(options?.timeoutMS).toBeGreaterThan(0);
      expect(options?.timeoutMS).toBeLessThanOrEqual(2_000);
      expect(input.singleBatch).toBe(true);
      expect(input.limit).toBeLessThanOrEqual(33);
      const data =
        input.find === 'files'
          ? stagedRows
          : stagedOriginals.filter(
              (row) =>
                row.tenantId === input.filter.tenantId &&
                row.userId === input.filter.userId &&
                (typeof input.filter.operationId === 'string'
                  ? row.operationId === input.filter.operationId
                  : input.filter.operationId.$in.includes(row.operationId)),
            );
      return { cursor: { id: 0, firstBatch: copy(data) } };
    },
  );
  const startNativeSession = jest.fn(() => {
    if (afterCallback) {
      const callback = afterCallback;
      afterCallback = undefined;
      callback();
    }
    stagedRows = copy(rows);
    stagedOriginals = copy(originals);
    return session;
  });
  Object.assign(session, { startTransaction: jest.fn() });
  let schema: mongoose.Schema;
  const connection = {
    Schema: mongoose.Schema,
    models: { File },
    connection: {
      readyState: 1,
      getClient: () => ({ startSession: startNativeSession, db: () => ({ command }) }),
    },
    model: jest.fn((_name: string, value: mongoose.Schema) => {
      schema = value;
      return Operation;
    }),
    startSession: jest.fn(async () => session),
  } as unknown as typeof mongoose;
  return {
    connection,
    File,
    Operation,
    session,
    command,
    startNativeSession,
    rows: () => rows,
    originals: () => originals,
    schema: () => schema,
    conflict: (callback: () => void) => {
      afterCallback = callback;
    },
    loseAck: () => {
      lostAck = true;
    },
    fill: (count: number) => {
      originals = Array.from({ length: count }, (_, i) => ({
        operationId: `prior-${i}`,
        // Deliberately truncated historical rows exercise the count limit before history decoding.
        original: {
          purpose: 'query',
          sources: [{ fileId: row().file_id }],
        } as unknown as FixtureOriginal,
      }));
    },
  };
}
const policySnapshot = (
  content: Omit<typeof policy, 'rankingPolicySha256'> & {
    rankingPolicySha256: string | null;
  } = copy(policy),
) => ({
  version: 1 as const,
  source: { provenanceSha256: content.provenanceSha256 },
  content,
  purge: [...new Set([0, 1, policy.writerEpoch, fixture.obligation.writerEpoch])].map(
    (writerEpoch) => ({ ...copy(content), writerEpoch }),
  ),
});
async function bind(db: ReturnType<typeof storage>, supplied = policySnapshot()) {
  const api = createFileRetrievalOperationOwner(db.connection, { policySnapshot: supplied });
  await api.initialize();
  const lookup = api.lookup;
  api.lookup = (
    value,
    peer,
    signal = new AbortController().signal,
    deadlineAt = Date.now() + 60_000,
  ) => lookup(value, peer, signal, deadlineAt);
  return api;
}
async function setup(supplied = policySnapshot()) {
  const db = storage();
  return { ...db, api: await bind(db, supplied) };
}
beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(now);
});
afterEach(() => jest.restoreAllMocks());

it('declares unique owner/operation identity and no automatic expiry', async () => {
  const db = await setup();
  expect(db.schema().indexes()).toEqual(
    expect.arrayContaining([
      [
        expect.objectContaining({ tenantId: 1, userId: 1, operationId: 1 }),
        expect.objectContaining({ unique: true }),
      ],
    ]),
  );
  expect(
    db
      .schema()
      .indexes()
      .some(([, options]) => options.expireAfterSeconds !== undefined),
  ).toBe(false);
  expect(db.schema().path('original').options.immutable).toBe(true);
});
it('requires server policy and rejects request-supplied policy before transaction effects', async () => {
  const db = storage();
  const api = createFileRetrievalOperationOwner(db.connection);
  await expect(api.admit(request())).rejects.toMatchObject({
    code: 'managed_retrieval_policy_unavailable',
  });
  await expect(
    api.admit({ ...request(), routePolicySha256: policy.routePolicySha256 } as Parameters<
      typeof api.admit
    >[0]),
  ).rejects.toThrow();
  expect(db.connection.startSession).not.toHaveBeenCalled();
});
it('commits original and index liability together, retaining only a body digest', async () => {
  const db = await setup();
  const original = await db.api.admit(request());
  expect(original.admittedAt).toBe(now);
  expect(original.workDeadline).toBe(now + 900_000);
  expect(original.cleanupDeadline).toBe(now + 1_800_000);
  expect(JSON.stringify(original)).not.toContain('private text');
  expect(db.originals()).toHaveLength(1);
  expect(db.rows()[0].managedRetrieval.obligations[0]).toMatchObject({
    operationId: original.operationId,
    state: 'preparing',
  });
  expect(db.File.updateOne.mock.calls[0][1].$inc).toEqual({ retentionRevision: 1 });
});
it('recovers a lost commit acknowledgement without a new clock or second liability', async () => {
  const db = await setup();
  db.loseAck();
  await expect(db.api.admit(request())).rejects.toThrow('UnknownTransactionCommitResult');
  const committed = copy(db.originals()[0].original);
  jest.spyOn(Date, 'now').mockReturnValue(now + 30_000);
  expect(await db.api.admit(request())).toEqual(committed);
  expect(db.originals()).toHaveLength(1);
  expect(db.rows()[0].managedRetrieval.obligations).toHaveLength(1);
});
it('rejects body or policy mismatch against an existing original', async () => {
  const db = await setup();
  await db.api.admit(request());
  await expect(db.api.admit({ ...request(), body: { query: 'changed' } })).rejects.toMatchObject({
    code: 'managed_retrieval_original_mismatch',
  });
  db.api = await bind(db, policySnapshot({ ...policy, provenanceSha256: '4'.repeat(64) }));
  await expect(db.api.admit(request())).rejects.toMatchObject({
    code: 'managed_retrieval_original_mismatch',
  });
  expect(db.originals()).toHaveLength(1);
});
it('uses the first admission clock after transaction retry', async () => {
  const db = await setup();
  db.conflict(() => jest.spyOn(Date, 'now').mockReturnValue(now + 10_000));
  const original = await db.api.admit(request());
  expect(original.admittedAt).toBe(now);
  expect(original.workDeadline).toBe(now + 900_000);
});
it('refuses a revocation race and rolls back the admission', async () => {
  const db = await setup();
  db.conflict(() => {
    db.rows()[0].deletionRequestedAt = new Date(now) as never;
  });
  await expect(db.api.admit(request())).rejects.toMatchObject({
    code: 'managed_retrieval_source_unavailable',
  });
  expect(db.originals()).toHaveLength(0);
  expect(db.rows()[0].managedRetrieval.obligations).toHaveLength(0);
});
it('refuses a zero-match File touch before creating an original', async () => {
  const db = await setup();
  db.File.updateOne.mockResolvedValueOnce({ matchedCount: 0 });
  await expect(db.api.admit(request())).rejects.toMatchObject({
    code: 'managed_retrieval_source_unavailable',
  });
  expect(db.Operation.create).not.toHaveBeenCalled();
});
it('bounds queries by their own 120s clock and every source expiry', async () => {
  const db = await setup();
  db.rows()[0].managedRetrieval.obligations = [{ ...fixture.obligation, state: 'ready' }];
  db.rows()[0].expiredAt = new Date(now + 45_000);
  const original = await db.api.admit(request('query'));
  expect(original.workDeadline).toBe(now + 45_000);
  expect(original.cleanupDeadline).toBe(now + 945_000);
});
it('charges every original query membership even when the backend key is unchanged', async () => {
  const db = await setup();
  db.rows()[0].managedRetrieval.obligations = [{ ...fixture.obligation, state: 'ready' }];
  db.fill(63);
  await db.api.admit(request('query'));
  await expect(
    db.api.admit({ ...request('query'), operationId: 'query-65' }),
  ).rejects.toMatchObject({ code: 'managed_retrieval_work_capacity' });
  expect(db.originals()).toHaveLength(64);
});
it('does not renew an expired original retry', async () => {
  const db = await setup();
  await db.api.admit(request());
  jest.spyOn(Date, 'now').mockReturnValue(now + 900_000);
  await expect(db.api.admit(request())).rejects.toMatchObject({
    code: 'managed_retrieval_original_expired',
  });
  expect(db.originals()[0].original.workDeadline).toBe(now + 900_000);
});
it('requires ranking authority for query', async () => {
  const db = await setup(policySnapshot({ ...policy, rankingPolicySha256: null }));
  await expect(db.api.admit(request('query'))).rejects.toMatchObject({
    code: 'managed_retrieval_policy_unavailable',
  });
});
it('retains request key order separately from canonical File write order', async () => {
  const db = await setup();
  const input = copy(fixture.revisionInput);
  input.fileId = 'zz-second-file';
  input.operationId = input.fileId;
  input.approval.subject.operationId = input.operationId;
  const second = row();
  second.file_id = input.fileId;
  second._id = 'row-second';
  second.managedRetrieval.revision = buildManagedRevision(input as never, (text) =>
    createHash('sha256').update(text).digest('hex'),
  ) as never;
  db.rows().push(second);
  const ids = [second.file_id, row().file_id];
  for (const file of db.rows())
    file.managedRetrieval.obligations = [
      {
        ...fixture.obligation,
        state: 'ready',
        key: {
          ...fixture.obligation.key,
          sourceRevision: file.managedRetrieval.revision.sourceRevision,
          representationRevision: file.managedRetrieval.revision.representationRevision,
        },
      },
    ];
  const original = await db.api.admit({ ...request('query'), fileIds: ids });
  expect(original.sources.map((source) => source.fileId)).toEqual(ids);
  expect(db.File.updateOne.mock.calls.map(([filter]) => filter.$and[1].file_id)).toEqual(
    [...ids].sort(),
  );
  expect(
    db.Operation.countDocuments.mock.calls.map(([filter]) => filter['original.sources.fileId']),
  ).toEqual([...ids].sort());
});

const hash = (value: unknown) =>
  createHash('sha256').update(canonicalManagedJson(value)).digest('hex');
function seedHistory(db: Awaited<ReturnType<typeof setup>>) {
  for (const entry of db.rows()[0].managedRetrieval.obligations) {
    const payload = {
      version: 1,
      owner,
      operationId: entry.operationId,
      purpose: 'index',
      bodySha256: entry.requestSha256,
      policy: {
        ...policy,
        backendIdentity: entry.backendIdentity,
        writerEpoch: entry.writerEpoch,
        indexGeneration: entry.key.indexGeneration,
      },
      sources: [
        {
          fileId: row().file_id,
          sourceRevision: fixture.revision.sourceRevision,
          representationRevision: fixture.revision.representationRevision,
          expiresAt: now + 1_000_000,
          keys: [entry.key],
          revisions: [copy(fixture.revision)],
        },
      ],
      admittedAt: now - 10_000,
      workDeadline: now + 890_000,
      cleanupDeadline: now + 1_790_000,
    };
    const record = {
      tenantId: owner.tenantId,
      userId: owner.userId,
      operationId: entry.operationId,
      original: { ...payload, originalSha256: hash(payload) },
    };
    const index = db.originals().findIndex((item) => item.operationId === entry.operationId);
    if (index >= 0) db.originals()[index] = record;
    else db.originals().push(record);
  }
}
const cleanups = (db: Awaited<ReturnType<typeof setup>>) =>
  db.originals().filter((record) => record.original.purpose === 'purge');
function liabilities(db: Awaited<ReturnType<typeof setup>>, count: number) {
  db.rows()[0].deletionRequestedAt = new Date(now - 1000);
  db.rows()[0].managedRetrieval.obligations = Array.from({ length: count }, (_, i) => ({
    ...copy(fixture.obligation),
    operationId: `history-${i}`,
    key: { ...fixture.obligation.key, indexGeneration: i.toString(16).padStart(64, '0') },
  }));
  seedHistory(db);
}
const purgeRequest = () => ({ owner, fileId: row().file_id });
it('rejects foreign retrieval metadata before interpreting empty cleanup inventory', async () => {
  const db = await setup();
  db.rows()[0].managedRetrieval.revision = {
    ...fixture.revision,
    owner: { ...owner, userId: 'foreign' },
  };
  await expect(db.api.admitPurge(purgeRequest())).rejects.toMatchObject({
    code: 'managed_retrieval_source_unavailable',
  });
  expect(db.Operation.create).not.toHaveBeenCalled();
});
it('reserves cleanup despite64 content originals and retains every content original', async () => {
  const db = await setup();
  db.fill(63);
  liabilities(db, 1);
  const operations = await db.api.admitPurge(purgeRequest());
  expect(operations).toHaveLength(1);
  expect(db.originals()).toHaveLength(65);
  expect(db.originals().filter((record) => record.original.purpose !== 'purge')).toHaveLength(64);
  expect(db.rows()[0].managedRetrieval.obligations[0].purgeOperationId).toBe(
    operations[0].operationId,
  );
});
it.each([33, 64])(
  'partitions all%s same-backend liabilities into bounded immutable operations',
  async (count) => {
    const db = await setup();
    liabilities(db, count);
    const operations = await db.api.admitPurge(purgeRequest());
    expect(operations).toHaveLength(2);
    expect(operations.flatMap((original) => original.sources[0].keys)).toHaveLength(count);
    expect(operations.every((original) => original.sources[0].keys.length <= 32)).toBe(true);
    expect(new Set(operations.flatMap((original) => original.cleanup!.slotIds)).size).toBe(count);
    expect(new Set(operations.map((original) => original.admittedAt))).toEqual(new Set([now]));
    expect(operations.every((original) => original.workDeadline === now + 900_000)).toBe(true);
    expect(db.rows()[0].managedRetrieval.obligations).toHaveLength(count);
    expect(db.File.updateOne).toHaveBeenCalledTimes(1);
  },
);
it('recovers all cleanup partitions after lostACK without a new clock or membership', async () => {
  const db = await setup();
  liabilities(db, 64);
  db.loseAck();
  await expect(db.api.admitPurge(purgeRequest())).rejects.toThrow('UnknownTransactionCommitResult');
  const committed = cleanups(db)
    .map((record) => copy(record.original))
    .sort((a, b) => a.operationId.localeCompare(b.operationId));
  db.rows()[0].managedRetrieval.obligations.reverse();
  jest.spyOn(Date, 'now').mockReturnValue(now + 30_000);
  expect(await db.api.admitPurge(purgeRequest())).toEqual(committed);
  expect(cleanups(db)).toHaveLength(2);
});
it('never reassigns or renews an expired cleanup slot', async () => {
  const db = await setup();
  liabilities(db, 33);
  const originals = await db.api.admitPurge(purgeRequest());
  jest.spyOn(Date, 'now').mockReturnValue(now + 2_000_000);
  expect(await db.api.admitPurge(purgeRequest())).toEqual(originals);
  expect(cleanups(db)).toHaveLength(2);
  expect(
    db
      .rows()[0]
      .managedRetrieval.obligations.every((entry) =>
        originals.some((original) => original.operationId === entry.purgeOperationId),
      ),
  ).toBe(true);
});
it('rolls back every partition and File claim if one original write fails', async () => {
  const db = await setup();
  liabilities(db, 64);
  const create = db.Operation.create.getMockImplementation()!;
  db.Operation.create
    .mockImplementationOnce(create)
    .mockRejectedValueOnce(new Error('second partition failure'));
  await expect(db.api.admitPurge(purgeRequest())).rejects.toThrow('second partition failure');
  expect(cleanups(db)).toHaveLength(0);
  expect(db.originals()).toHaveLength(64);
  expect(db.rows()[0].managedRetrieval.obligations.every((entry) => !entry.purgeOperationId)).toBe(
    true,
  );
});
it('refuses an orphan cleanup claim instead of manufacturing a replacement original', async () => {
  const db = await setup();
  liabilities(db, 1);
  db.rows()[0].managedRetrieval.obligations[0].purgeOperationId = 'missing-original';
  await expect(db.api.admitPurge(purgeRequest())).rejects.toMatchObject({
    code: 'managed_retrieval_cleanup_mismatch',
  });
  expect(db.Operation.create).not.toHaveBeenCalled();
});
it('creates no free cleanup original for absent or caller-selected liabilities', async () => {
  const db = await setup();
  await expect(db.api.admitPurge(purgeRequest())).rejects.toMatchObject({
    code: 'managed_retrieval_inventory_unresolved',
  });
  await expect(
    db.api.admitPurge({ ...purgeRequest(), keys: [fixture.obligation.key] } as Parameters<
      typeof db.api.admitPurge
    >[0]),
  ).rejects.toThrow();
  expect(db.Operation.create).not.toHaveBeenCalled();
});

it('keeps retained epochs separate and supplies the original epoch to backend purge', async () => {
  const db = await setup();
  liabilities(db, 4);
  db.rows()[0].managedRetrieval.obligations.forEach((entry, i) => {
    entry.writerEpoch = i % 2;
  });
  seedHistory(db);
  const operations = await db.api.admitPurge(purgeRequest());
  expect(operations).toHaveLength(2);
  expect(new Set(operations.map((original) => original.policy.writerEpoch))).toEqual(
    new Set([0, 1]),
  );
  for (const original of operations) {
    const assigned = db
      .rows()[0]
      .managedRetrieval.obligations.filter(
        (entry) => entry.purgeOperationId === original.operationId,
      );
    expect(assigned.every((entry) => entry.writerEpoch === original.policy.writerEpoch)).toBe(true);
  }
});
it('retains one firstP across a retry of the entire cleanup transaction', async () => {
  const db = await setup();
  liabilities(db, 64);
  db.conflict(() => jest.spyOn(Date, 'now').mockReturnValue(now + 20_000));
  const operations = await db.api.admitPurge(purgeRequest());
  expect(
    operations.every(
      (original) => original.admittedAt === now && original.workDeadline === now + 900_000,
    ),
  ).toBe(true);
  expect(cleanups(db)).toHaveLength(2);
});

const lookupRequest = (operationId = request().operationId, requestedPurpose = 'index') => ({
  version: 1,
  owner,
  operationId,
  requestedPurpose,
});
const peer = { backendIdentity: policy.backendIdentity };
it('retains exact verified full revision in the immutable original before dispatch', async () => {
  const db = await setup();
  const original = await db.api.admit(request());
  expect(original.sources[0].revisions).toEqual([fixture.revision]);
  const { originalSha256, ...payload } = original;
  expect(originalSha256).toBe(hash(payload));
  db.rows()[0].managedRetrieval.revision = null as never;
  expect(db.originals()[0].original.sources[0].revisions).toEqual([fixture.revision]);
});
it('serves strict independent lookup without writes and projects original milliseconds only once', async () => {
  const db = await setup();
  const original = await db.api.admit(request());
  db.File.updateOne.mockClear();
  db.Operation.create.mockClear();
  const result = await db.api.lookup(lookupRequest(), peer);
  expect(result).toMatchObject({
    status: 'available',
    original: {
      originalSha256: original.originalSha256,
      workDeadline: (now + 900_000) / 1000,
      technicalCleanupDeadline: (now + 1_800_000) / 1000,
    },
    authority: { requestSha256: original.bodySha256, cleanupDeadline: null },
    sources: [{ revision: fixture.revision, indexOriginal: { operationId: original.operationId } }],
  });
  expect(db.File.updateOne).not.toHaveBeenCalled();
  expect(db.Operation.create).not.toHaveBeenCalled();
  expect(
    db.session.withTransaction.mock.calls[db.session.withTransaction.mock.calls.length - 1],
  ).toHaveLength(2);
});
it('rejects injected lookup authority and wrong authenticated backend without effects', async () => {
  const db = await setup();
  await db.api.admit(request());
  await expect(
    db.api.lookup({ ...lookupRequest(), backendIdentity: peer.backendIdentity }, peer),
  ).rejects.toThrow();
  expect(await db.api.lookup(lookupRequest(), { backendIdentity: 'foreign' })).toMatchObject({
    status: 'unavailable',
    reason: 'backend_mismatch',
  });
  expect(await db.api.lookup(lookupRequest(undefined, 'query'), peer)).toMatchObject({
    status: 'unavailable',
    reason: 'purpose_mismatch',
  });
});
it('keeps status unavailable before lookup or any new clock', async () => {
  const db = await setup();
  expect(await db.api.lookup(lookupRequest(undefined, 'status'), peer)).toEqual({
    version: 1,
    status: 'unavailable',
    reason: 'status_contract_unselected',
  });
  expect(db.connection.startSession).not.toHaveBeenCalled();
});
it.each(['delete', 'expire', 'policy'])('refuses live content after %s changes', async (change) => {
  const db = await setup();
  await db.api.admit(request());
  if (change === 'delete') db.rows()[0].deletionRequestedAt = new Date(now);
  if (change === 'expire') db.rows()[0].expiredAt = new Date(now);
  if (change === 'policy')
    db.api = await bind(db, policySnapshot({ ...policy, routePolicySha256: 'f'.repeat(64) }));
  expect(await db.api.lookup(lookupRequest(), peer)).toMatchObject({ status: 'unavailable' });
});
it('purges the retained original revision after source deletion without backend admission', async () => {
  const db = await setup();
  const index = await db.api.admit(request());
  db.rows()[0].deletionRequestedAt = new Date(now);
  const [purge] = await db.api.admitPurge(purgeRequest());
  expect(purge.sources[0].revisions).toEqual(index.sources[0].revisions);
  const result = await db.api.lookup(lookupRequest(purge.operationId, 'purge'), peer);
  expect(result).toMatchObject({
    status: 'available',
    authority: { cleanupDeadline: (now + 900_000) / 1000 },
    sources: [
      {
        revision: fixture.revision,
        contentState: 'revoked',
        indexOriginal: { operationId: index.operationId },
      },
    ],
  });
});
it('missing historical proof rolls back every purge partition and retains all liabilities', async () => {
  const db = await setup();
  liabilities(db, 33);
  db.originals().pop();
  await expect(db.api.admitPurge(purgeRequest())).rejects.toMatchObject({
    code: 'managed_retrieval_history_unavailable',
  });
  expect(cleanups(db)).toHaveLength(0);
  expect(db.Operation.create).not.toHaveBeenCalled();
  expect(db.rows()[0].managedRetrieval.obligations).toHaveLength(33);
  expect(db.rows()[0].managedRetrieval.obligations.every((entry) => !entry.purgeOperationId)).toBe(
    true,
  );
});
it.each([false, true])(
  'rejects tampered history even with recomputed record hash=%s',
  async (rehash) => {
    const db = await setup();
    await db.api.admit(request());
    const original = db.originals()[0].original;
    original.sources[0].revisions[0].source.originalBytes++;
    if (rehash) {
      const { originalSha256: _originalSha256, ...payload } = original;
      original.originalSha256 = hash(payload);
    }
    expect(await db.api.lookup(lookupRequest(), peer)).toMatchObject({
      status: 'unavailable',
      reason: 'history_unavailable',
    });
  },
);
it('deletion before the bounded snapshot denies content without automatic retries', async () => {
  const db = await setup();
  await db.api.admit(request());
  db.conflict(() => {
    db.rows()[0].deletionRequestedAt = new Date(now);
  });
  expect(await db.api.lookup(lookupRequest(), peer)).toMatchObject({ status: 'unavailable' });
});
it('uses current File retention for a new query after +7 without renewing original work', async () => {
  const db = await setup();
  const index = await db.api.admit(request());
  const originalIndex = copy(db.originals()[0].original);
  const oldExpiry = new Date(db.rows()[0].expiredAt).getTime();
  db.rows()[0].managedRetrieval.obligations[0].state = 'ready';
  const prior = await db.api.admit({ ...request('query'), operationId: 'prior-query' });
  db.rows()[0].expiredAt = new Date(oldExpiry + 7 * 86_400_000);
  jest.spyOn(Date, 'now').mockReturnValue(oldExpiry + 1000);
  const query = await db.api.admit({ ...request('query'), operationId: 'query-original' });
  const selector = lookupRequest(query.operationId, 'query');
  const result = await db.api.lookup(selector, peer);
  expect(result).toMatchObject({
    status: 'available',
    operationId: query.operationId,
    authority: {
      workDeadline: query.workDeadline / 1000,
      sourceExpiresAt: (oldExpiry + 7 * 86_400_000) / 1000,
    },
    sources: [
      { originalExpiresAt: oldExpiry / 1000, indexOriginal: { operationId: index.operationId } },
    ],
  });
  expect(
    validateManagedRetrievalLookup(result, selector as never, peer.backendIdentity, (value) =>
      createHash('sha256').update(value).digest('hex'),
    ),
  ).toEqual(result);
  expect(query.workDeadline).toBe(oldExpiry + 121_000);
  expect(db.originals()[0].original).toEqual(originalIndex);
  expect(await db.api.lookup(lookupRequest(prior.operationId, 'query'), peer)).toMatchObject({
    status: 'unavailable',
    reason: 'original_expired',
  });
  jest.spyOn(Date, 'now').mockReturnValue(query.workDeadline);
  expect(await db.api.lookup(selector, peer)).toMatchObject({
    status: 'unavailable',
    reason: 'original_expired',
  });
});

it('preserves the existing prohibition on changing a File revision with retained obligations', async () => {
  const db = await setup();
  await db.api.admit(request());
  const input = copy(fixture.revisionInput);
  input.extractionPolicySha256 = 'f'.repeat(64);
  db.rows()[0].managedRetrieval.revision = buildManagedRevision(input as never, (text) =>
    createHash('sha256').update(text).digest('hex'),
  ) as never;
  await expect(db.api.admitPurge(purgeRequest())).rejects.toThrow(
    'Duplicate or foreign obligation',
  );
  expect(cleanups(db)).toHaveLength(0);
  expect(await db.api.lookup(lookupRequest(), peer)).toMatchObject({ status: 'unavailable' });
});
it('historical index generations use their own immutable originals for every ordered key', async () => {
  const db = await setup();
  liabilities(db, 33);
  const partitions = await db.api.admitPurge(purgeRequest());
  for (const operation of partitions) {
    const result = await db.api.lookup(lookupRequest(operation.operationId, 'purge'), peer);
    expect(result.status).toBe('available');
    if (result.status !== 'available') throw new Error('lookup unavailable');
    expect(result.sources.map((source) => source.key)).toEqual(operation.sources[0].keys);
    for (const source of result.sources) {
      const original = db
        .originals()
        .find((entry) => entry.operationId === source.indexOriginal.operationId)!.original;
      expect(source.revision).toEqual(original.sources[0].revisions[0]);
      expect(source.key.indexGeneration).toBe(original.policy.indexGeneration);
    }
  }
});
it('expired cleanup remains retained but cannot authorize new backend dispatch', async () => {
  const db = await setup();
  liabilities(db, 1);
  const [purge] = await db.api.admitPurge(purgeRequest());
  jest.spyOn(Date, 'now').mockReturnValue(now + 900_000);
  expect(await db.api.lookup(lookupRequest(purge.operationId, 'purge'), peer)).toMatchObject({
    status: 'unavailable',
    reason: 'original_expired',
  });
  expect(await db.api.admitPurge(purgeRequest())).toEqual([purge]);
  expect(cleanups(db)).toHaveLength(1);
});
it('rounds a shortened live expiry down and never refreshes its original work clock', async () => {
  const db = await setup();
  const original = await db.api.admit(request());
  db.rows()[0].expiredAt = new Date(now + 45_999);
  const result = await db.api.lookup(lookupRequest(), peer);
  expect(result).toMatchObject({
    status: 'available',
    authority: { sourceExpiresAt: now / 1000 + 45, workDeadline: original.workDeadline / 1000 },
  });
});

it('does not backfill missing historical snapshots from the current File revision', async () => {
  const db = await setup();
  await db.api.admit(request());
  const original = db.originals()[0].original;
  delete (original.sources[0] as Partial<FixtureOriginal['sources'][number]>).revisions;
  const { originalSha256: _originalSha256, ...payload } = original;
  original.originalSha256 = hash(payload);
  expect(await db.api.lookup(lookupRequest(), peer)).toMatchObject({
    status: 'unavailable',
    reason: 'history_unavailable',
  });
  db.rows()[0].deletionRequestedAt = new Date(now);
  await expect(db.api.admitPurge(purgeRequest())).rejects.toMatchObject({
    code: 'managed_retrieval_history_unavailable',
  });
  expect(cleanups(db)).toHaveLength(0);
});
it('does not substitute another original index operation for the same source key', async () => {
  const db = await setup();
  await db.api.admit(request());
  const other = copy(db.originals()[0]);
  other.operationId = 'other-index';
  other.original.operationId = other.operationId;
  const { originalSha256: _originalSha256, ...payload } = other.original;
  other.original.originalSha256 = hash(payload);
  db.originals().push(other);
  db.rows()[0].managedRetrieval.obligations[0].operationId = other.operationId;
  expect(await db.api.lookup(lookupRequest(), peer)).toMatchObject({
    status: 'unavailable',
    reason: 'history_unavailable',
  });
});

it('rejects multi-source INDEX before transaction effects', async () => {
  const db = await setup();
  await expect(
    db.api.admit({ ...request(), fileIds: [row().file_id, 'second-file'] }),
  ).rejects.toThrow('exactly one File');
  expect(db.connection.startSession).not.toHaveBeenCalled();
});
it('already-aborted lookup never starts a session or command', async () => {
  const db = await setup();
  await db.api.admit(request());
  const controller = new AbortController();
  controller.abort();
  expect(await db.api.lookup(lookupRequest(), peer, controller.signal, now + 1000)).toMatchObject({
    status: 'unavailable',
  });
  expect(db.startNativeSession).not.toHaveBeenCalled();
  expect(db.command).not.toHaveBeenCalled();
});
it.each([1, 2, 4])(
  'cancels and joins stalled native command%s before bounded session cleanup',
  async (number) => {
    const db = await setup();
    await db.api.admit(request());
    let active = false;
    let joined = false;
    const read = db.command.getMockImplementation()!;
    let called = 0;
    db.command.mockImplementation(async (input, options) => {
      if (++called !== number) return read(input, options);
      active = true;
      return new Promise((_, reject) =>
        options.signal.addEventListener(
          'abort',
          () => {
            active = false;
            joined = true;
            reject(options.signal.reason);
          },
          { once: true },
        ),
      );
    });
    db.session.endSession.mockImplementation(async (options?: { timeoutMS: number }) => {
      expect(active).toBe(false);
      expect(joined).toBe(true);
      expect(options?.timeoutMS).toBe(5000);
    });
    expect(
      await db.api.lookup(lookupRequest(), peer, new AbortController().signal, now + 25),
    ).toMatchObject({ status: 'unavailable' });
    expect(joined).toBe(true);
    expect(db.session.endSession).toHaveBeenCalledTimes(2);
  },
);
it('batches history lookup once instead of issuing one query per source key', async () => {
  const db = await setup();
  liabilities(db, 32);
  const [purge] = await db.api.admitPurge(purgeRequest());
  expect(await db.api.lookup(lookupRequest(purge.operationId, 'purge'), peer)).toMatchObject({
    status: 'available',
  });
  expect(db.command).toHaveBeenCalledTimes(3);
});
it('cleanup timeout is reported as unresolved and cannot return available', async () => {
  const db = await setup();
  await db.api.admit(request());
  db.session.endSession.mockImplementation(async (options?: { timeoutMS: number }) => {
    expect(options?.timeoutMS).toBe(5000);
    throw Object.assign(new Error('cleanup stalled'), { name: 'MongoOperationTimeoutError' });
  });
  await expect(db.api.lookup(lookupRequest(), peer)).rejects.toMatchObject({
    code: 'managed_retrieval_lookup_cleanup_unresolved',
  });
});

it('cleans the request timer and abort subscription if native session construction throws', async () => {
  const db = await setup();
  await db.api.admit(request());
  const controller = new AbortController();
  const remove = jest.spyOn(controller.signal, 'removeEventListener');
  db.startNativeSession.mockImplementationOnce(() => {
    throw new Error('client closed');
  });
  await expect(db.api.lookup(lookupRequest(), peer, controller.signal, now + 1000)).rejects.toThrow(
    'client closed',
  );
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  expect(db.command).not.toHaveBeenCalled();
});

it('rejects the removed async policy callback without invoking or waiting for it', async () => {
  const db = storage();
  const resolvePolicy = jest.fn(() => new Promise(() => {}));
  const api = createFileRetrievalOperationOwner(db.connection, {
    resolvePolicy,
  } as unknown as Parameters<typeof createFileRetrievalOperationOwner>[1]);
  await api.initialize();
  await expect(api.admit(request())).rejects.toMatchObject({
    code: 'managed_retrieval_policy_unavailable',
  });
  expect(
    await api.lookup(lookupRequest(), peer, new AbortController().signal, now + 1000),
  ).toMatchObject({ reason: 'policy_unavailable' });
  await expect(api.admitPurge(purgeRequest())).rejects.toMatchObject({
    code: 'managed_retrieval_policy_unavailable',
  });
  expect(resolvePolicy).not.toHaveBeenCalled();
  expect(db.command).not.toHaveBeenCalled();
});
it.each(['absent', 'missing-source', 'unsupported', 'unbound', 'ambiguous', 'promise'])(
  'denies malformed trusted policy %s without DB effects',
  async (kind) => {
    const db = storage();
    const supplied = policySnapshot();
    let input: unknown = supplied;
    if (kind === 'absent') input = undefined;
    if (kind === 'missing-source') delete (supplied as Partial<typeof supplied>).source;
    if (kind === 'unsupported') (supplied as { version: number }).version = 2;
    if (kind === 'unbound') supplied.source.provenanceSha256 = 'f'.repeat(64);
    if (kind === 'ambiguous') supplied.purge.push(copy(supplied.purge[0]));
    if (kind === 'promise') input = new Promise(() => {});
    const api = createFileRetrievalOperationOwner(db.connection, {
      policySnapshot: input as FileRetrievalPolicySnapshot | undefined,
    });
    await api.initialize();
    await expect(api.admit(request())).rejects.toMatchObject({
      code: 'managed_retrieval_policy_unavailable',
    });
    expect(
      await api.lookup(lookupRequest(), peer, new AbortController().signal, now + 1000),
    ).toMatchObject({ reason: 'policy_unavailable' });
    expect(db.startNativeSession).not.toHaveBeenCalled();
    expect(db.command).not.toHaveBeenCalled();
  },
);
it('copies the trusted snapshot once and never accepts caller mutation as a policy refresh', async () => {
  const supplied = policySnapshot();
  const db = await setup(supplied);
  supplied.content.routePolicySha256 = 'f'.repeat(64);
  supplied.purge.length = 0;
  const original = await db.api.admit(request());
  expect(original.policy.routePolicySha256).toBe(policy.routePolicySha256);
  original.policy.routePolicySha256 = 'e'.repeat(64);
  expect(await db.api.lookup(lookupRequest(), peer)).toMatchObject({
    status: 'available',
    original: { routePolicySha256: policy.routePolicySha256 },
  });
});
it('keeps unsupported historical cleanup pending without inventing a policy', async () => {
  const supplied = policySnapshot();
  supplied.purge = [];
  const db = await setup(supplied);
  await db.api.admit(request());
  db.rows()[0].deletionRequestedAt = new Date(now);
  db.Operation.create.mockClear();
  await expect(db.api.admitPurge(purgeRequest())).rejects.toMatchObject({
    code: 'managed_retrieval_policy_unavailable',
  });
  expect(db.Operation.create).not.toHaveBeenCalled();
  expect(cleanups(db)).toHaveLength(0);
  expect(db.rows()[0].managedRetrieval.obligations[0].purgeOperationId).toBeUndefined();
});
it('passes the same signal and diminishing absolute budget to every batched read', async () => {
  const db = await setup();
  await db.api.admit(request());
  const read = db.command.getMockImplementation()!;
  db.command.mockImplementation(async (input, options) => {
    await new Promise((resolve) => setTimeout(resolve, 8));
    return read(input, options);
  });
  expect(
    await db.api.lookup(lookupRequest(), peer, new AbortController().signal, now + 100),
  ).toMatchObject({ status: 'available' });
  const options = db.command.mock.calls.map(([, options]) => options);
  expect(options).toHaveLength(4);
  expect(new Set(options.map((value) => value.signal)).size).toBe(1);
  for (let index = 1; index < options.length; index++)
    expect(options[index].timeoutMS).toBeLessThan(options[index - 1].timeoutMS);
  expect(options.every((value) => value.timeoutMS <= 100)).toBe(true);
});

it('retains request ownership while cleanup settles even after caller cancellation', async () => {
  const db = await setup();
  await db.api.admit(request());
  let started!: () => void;
  let release!: () => void;
  const cleanupStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  db.session.endSession.mockImplementation(async (options?: { timeoutMS: number }) => {
    expect(options?.timeoutMS).toBe(5000);
    await new Promise<void>((resolve) => {
      release = resolve;
      started();
    });
  });
  const controller = new AbortController();
  const pending = db.api.lookup(lookupRequest(), peer, controller.signal, now + 1000);
  await cleanupStarted;
  controller.abort();
  let settled = false;
  pending.then(() => {
    settled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
  release();
  expect(await pending).toMatchObject({ status: 'unavailable' });
});

it('keeps explicitly retained cleanup policy and clocks across a content policy generation change', async () => {
  const db = await setup();
  await db.api.admit(request());
  db.rows()[0].deletionRequestedAt = new Date(now);
  const [purge] = await db.api.admitPurge(purgeRequest());
  const next = policySnapshot({ ...policy, provenanceSha256: '4'.repeat(64) });
  next.purge = policySnapshot().purge;
  db.api = await bind(db, next);
  expect(await db.api.admitPurge(purgeRequest())).toEqual([purge]);
  expect(await db.api.lookup(lookupRequest(purge.operationId, 'purge'), peer)).toMatchObject({
    status: 'available',
    original: {
      policyProvenanceSha256: policy.provenanceSha256,
      workDeadline: purge.workDeadline / 1000,
    },
  });
});

/** Changed composition edges: actual File owner and shared validators; no backend or Mongo claim. */
const indexReceipt = (
  original: Awaited<ReturnType<ReturnType<typeof createFileRetrievalOperationOwner>['admit']>>,
) => {
  const payload = {
    version: 1 as const,
    operationId: original.operationId,
    requestSha256: original.bodySha256,
    backendIdentity: original.policy.backendIdentity,
    writerEpoch: original.policy.writerEpoch,
    key: original.sources[0].keys[0],
    state: 'ready' as const,
    completedAt: Math.floor(now / 1000),
  };
  return { ...payload, receiptSha256: hash(payload) };
};
const purgeReceipt = (
  original: Awaited<ReturnType<ReturnType<typeof createFileRetrievalOperationOwner>['admit']>>,
) => {
  const payload = {
    version: 1 as const,
    purgeOperationId: original.operationId,
    keys: original.sources[0].keys,
    backendIdentity: original.policy.backendIdentity,
    fenceEpoch: original.policy.writerEpoch + 1,
    state: 'purged' as const,
    remainingChunks: 0 as const,
    activeWriters: 0 as const,
    completedAt: Math.floor(now / 1000),
  };
  return { ...payload, receiptSha256: hash(payload) };
};
it('composition advances fresh custody with the durable admission and rolls both back on zero touch', async () => {
  const db = await setup();
  const file = db.rows()[0] as ReturnType<typeof row> & {
    uploadOperationId: string;
    retrievalCreation: ReturnType<typeof createManagedFileRetrievalInventory>;
  };
  file.uploadOperationId = file.file_id;
  file.retrievalCreation = createManagedFileRetrievalInventory(owner, file.file_id, now - 1000);
  db.File.updateOne.mockResolvedValueOnce({ matchedCount: 0 });
  await expect(db.api.admit(request())).rejects.toThrow();
  expect(db.rows()[0].retrievalCreation!.state).toBe('empty');
  expect(db.originals()).toHaveLength(0);
  await db.api.admit(request());
  expect(db.rows()[0].retrievalCreation!.state).toBe('admitted');
  expect(db.rows()[0].managedRetrieval.obligations).toHaveLength(1);
  expect(db.originals()).toHaveLength(1);
});
it('composition retains exact index receipt with ready state and rejects replacement', async () => {
  const db = await setup();
  const original = await db.api.admit(request());
  const receipt = indexReceipt(original);
  await db.api.acknowledgeIndex({ owner, operationId: original.operationId, receipt }, peer);
  expect(db.rows()[0].managedRetrieval.obligations[0].state).toBe('ready');
  expect(db.originals()[0].indexReceipt).toEqual(receipt);
  expect(db.originals()[0].original).toEqual(original);
  await db.api.acknowledgeIndex({ owner, operationId: original.operationId, receipt }, peer);
  const { receiptSha256: _old, ...payload } = { ...receipt, completedAt: receipt.completedAt + 1 };
  await expect(
    db.api.acknowledgeIndex(
      {
        owner,
        operationId: original.operationId,
        receipt: { ...payload, receiptSha256: hash(payload) },
      },
      peer,
    ),
  ).rejects.toThrow();
  expect(db.originals()[0].indexReceipt).toEqual(receipt);
});
it('composition rolls index receipt back when the File touch cannot commit', async () => {
  const db = await setup();
  const original = await db.api.admit(request());
  db.File.updateOne.mockResolvedValueOnce({ matchedCount: 0 });
  await expect(
    db.api.acknowledgeIndex(
      { owner, operationId: original.operationId, receipt: indexReceipt(original) },
      peer,
    ),
  ).rejects.toThrow();
  expect(db.rows()[0].managedRetrieval.obligations[0].state).toBe('preparing');
  expect(db.originals()[0].indexReceipt).toBeUndefined();
});
it('composition cannot acknowledge ready across a revocation retry', async () => {
  const db = await setup();
  const original = await db.api.admit(request());
  db.conflict(() => {
    db.rows()[0].deletionRequestedAt = new Date(now);
  });
  await expect(
    db.api.acknowledgeIndex(
      { owner, operationId: original.operationId, receipt: indexReceipt(original) },
      peer,
    ),
  ).rejects.toThrow();
  expect(db.rows()[0].managedRetrieval.obligations[0].state).toBe('preparing');
  expect(db.originals()[0].indexReceipt).toBeUndefined();
});
it.each(['peer', 'deadline', 'purge'])(
  'composition refuses a ready receipt after %s authority changes',
  async (change) => {
    const db = await setup();
    const original = await db.api.admit(request());
    if (change === 'deadline') jest.spyOn(Date, 'now').mockReturnValue(original.workDeadline);
    if (change === 'purge') await db.api.admitPurge(purgeRequest());
    await expect(
      db.api.acknowledgeIndex(
        { owner, operationId: original.operationId, receipt: indexReceipt(original) },
        change === 'peer' ? { backendIdentity: 'foreign' } : peer,
      ),
    ).rejects.toThrow();
    expect(db.originals()[0].indexReceipt).toBeUndefined();
  },
);
it('composition purges each complete partition once and retains its original after the old deadline', async () => {
  const db = await setup();
  liabilities(db, 33);
  const originals = await db.api.admitPurge(purgeRequest());
  await db.api.acknowledgePurge(
    { owner, operationId: originals[0].operationId, receipt: purgeReceipt(originals[0]) },
    peer,
  );
  expect(await db.api.admitPurge(purgeRequest())).toEqual([originals[1]]);
  await db.api.acknowledgePurge(
    { owner, operationId: originals[1].operationId, receipt: purgeReceipt(originals[1]) },
    peer,
  );
  jest.spyOn(Date, 'now').mockReturnValue(now + 2_000_000);
  expect(await db.api.admitPurge(purgeRequest())).toEqual([]);
  expect(
    cleanups(db)
      .map((record) => record.original)
      .sort((a, b) => a.operationId.localeCompare(b.operationId)),
  ).toEqual(originals);
  expect(db.rows()[0].managedRetrieval.obligations.every((entry) => entry.state === 'purged')).toBe(
    true,
  );
});
it('composition refuses a partial terminal partition instead of synthesizing a replay receipt', async () => {
  const db = await setup();
  liabilities(db, 2);
  const [original] = await db.api.admitPurge(purgeRequest());
  await db.api.acknowledgePurge(
    { owner, operationId: original.operationId, receipt: purgeReceipt(original) },
    peer,
  );
  db.rows()[0].managedRetrieval.obligations[0].state = 'purge_pending';
  await expect(db.api.admitPurge(purgeRequest())).rejects.toMatchObject({
    code: 'managed_retrieval_cleanup_mismatch',
  });
});
