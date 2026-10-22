import mongoose from 'mongoose';
import { createHash } from 'crypto';
import { performance } from 'node:perf_hooks';
import type { TCheckpointerConfig } from 'librechat-data-provider';
import type { ResolvedCheckpointerConfig } from './config';
import { checkpointOwnerNamespacePrefix } from '../../stream/checkpoints';
import { resolveCheckpointerConfig } from './config';

export const CHECKPOINT_STORAGE_COLLECTION = 'agent_checkpoint_stores';
export const LIBRECHAT_CHECKPOINT_STORAGE_OWNER_KEY = '__librechat_checkpoint_storage_owner';
export type CheckpointStorage = Omit<ResolvedCheckpointerConfig, 'ttlSeconds'>;
export interface CheckpointStorageRecord {
  _id: string;
  owner: string;
  storage: CheckpointStorage;
}

export interface InitialCheckpointPopulationOptions {
  /** Canonical millisecond ISO-Z wire timestamp; retained verbatim across activation retries. */
  originalDeadline: string;
  targetBindingSha256: string;
  /** Explicit actual resolved configuration; an omitted configuration is never the default. */
  currentConfig: ResolvedCheckpointerConfig;
}

export interface InitialCheckpointPopulation {
  schema: 1;
  owner: 'agent-checkpoints';
  originalDeadline: string;
  observedFrom: string;
  observedThrough: string;
  targetBindingSha256: string;
  configurationSha256: string;
  saturatedCounts: { recoveryCopies: 0 | 1 };
  /** Existing opaque checkpoint/write rows are possible source copies, never source-free proof. */
  complete: boolean;
  evidenceSha256: string;
}

export interface CheckpointIndexPopulationOptions extends InitialCheckpointPopulationOptions {
  /** Trusted caller's complete configuration history, including an explicitly empty history. */
  historicalStorageLineage?: {
    evidenceSha256: string;
    stores: readonly CheckpointStorage[];
  };
}

export interface CheckpointPhysicalIndex {
  name: string;
  key: Record<string, number | string>;
  unique: boolean;
  building: boolean;
  sparse: boolean;
  partial: boolean;
  collation: 'simple' | 'other';
  expireAfterSeconds?: number;
}

export interface CheckpointCollectionPopulation {
  collection: string;
  role: 'checkpoint' | 'pending';
  rowCount: number;
  malformedKeyRows: number;
  duplicateGroups: number;
  duplicateExcessRows: number;
  indexes: CheckpointPhysicalIndex[];
  indexStatus: 'verified' | 'missing' | 'conflicting';
}

export interface CheckpointIndexPopulation {
  schema: 1;
  owner: 'agent-checkpoints';
  originalDeadline: string;
  observedFrom: string;
  observedThrough: string;
  targetBindingSha256: string;
  configurationSha256: string;
  historicalLineageSha256: string | null;
  collections: CheckpointCollectionPopulation[];
  /** Read-only evidence, never writer custody or permission to build an index. */
  complete: boolean;
  evidenceSha256: string;
}

function failCheckpointInventory(): never {
  throw new Error('Initial checkpoint inventory is unavailable or incomplete');
}

function inventoryStorage(value: unknown): CheckpointStorage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) failCheckpointInventory();
  const storage = value as Record<string, unknown>;
  if (
    storage.type !== 'mongo' ||
    Object.keys(storage).sort().join(',') !==
      'checkpointCollectionName,checkpointWritesCollectionName,type'
  )
    failCheckpointInventory();
  for (const field of ['checkpointCollectionName', 'checkpointWritesCollectionName']) {
    const name = storage[field];
    if (
      typeof name !== 'string' ||
      !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,119}$/.test(name) ||
      name.startsWith('system.')
    )
      failCheckpointInventory();
  }
  return {
    type: 'mongo',
    checkpointCollectionName: storage.checkpointCollectionName as string,
    checkpointWritesCollectionName: storage.checkpointWritesCollectionName as string,
  };
}

function createCheckpointInventory(options: InitialCheckpointPopulationOptions) {
  const observedFrom = Date.now();
  const started = performance.now();
  const originalDeadline = options?.originalDeadline;
  const targetBindingSha256 = options?.targetBindingSha256;
  if (
    typeof originalDeadline !== 'string' ||
    originalDeadline.length !== 24 ||
    typeof targetBindingSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(targetBindingSha256)
  )
    failCheckpointInventory();
  const deadlineMs = Date.parse(originalDeadline);
  if (!Number.isSafeInteger(deadlineMs) || new Date(deadlineMs).toISOString() !== originalDeadline)
    failCheckpointInventory();
  const remaining = (): number => {
    const now = Date.now();
    if (now < observedFrom) return failCheckpointInventory();
    const milliseconds = Math.floor(
      Math.min(
        deadlineMs - now,
        10_000 - (now - observedFrom),
        10_000 - (performance.now() - started),
      ),
    );
    if (milliseconds <= 0) return failCheckpointInventory();
    return milliseconds;
  };
  remaining();
  const current = options.currentConfig;
  if (
    !current ||
    typeof current !== 'object' ||
    Array.isArray(current) ||
    Object.keys(current).sort().join(',') !==
      'checkpointCollectionName,checkpointWritesCollectionName,ttlSeconds,type' ||
    typeof current.ttlSeconds !== 'number' ||
    !Number.isFinite(current.ttlSeconds) ||
    current.ttlSeconds <= 0
  )
    failCheckpointInventory();
  const { ttlSeconds, ...rawStorage } = current;
  const storage = inventoryStorage(rawStorage);
  const normalizedConfig: ResolvedCheckpointerConfig = { ...storage, ttlSeconds };
  const configJSON = JSON.stringify(
    Object.fromEntries(Object.entries(normalizedConfig).sort(([a], [b]) => a.localeCompare(b))),
  );
  const configurationSha256 = createHash('sha256').update(configJSON).digest('hex');
  const db = mongoose.connection.db;
  if (!db || mongoose.connection.readyState !== 1) failCheckpointInventory();
  const evidence = createHash('sha256').update(configJSON);
  const read = async (
    name: string,
    pipeline: Record<string, unknown>[],
  ): Promise<Record<string, unknown>[]> => {
    // timeoutMS covers the non-tailable cursor lifetime by default. The native driver
    // awaits cursor cleanup, which may use one fresh timeout budget.
    // Reserve that budget inside the caller deadline instead of racing a pending read.
    const timeoutMS = Math.min(2000, Math.floor(remaining() / 2));
    if (timeoutMS < 1) return failCheckpointInventory();
    try {
      const rows = await db
        .collection(name)
        .aggregate(pipeline, {
          readPreference: 'primary',
          readConcern: { level: 'majority' },
          maxTimeMS: timeoutMS,
          timeoutMS,
          allowDiskUse: false,
          collation: { locale: 'simple' },
        })
        .toArray();
      remaining();
      evidence.update(JSON.stringify([name, rows]));
      return rows;
    } catch {
      return failCheckpointInventory();
    }
  };
  return {
    observedFrom,
    originalDeadline,
    targetBindingSha256,
    configurationSha256,
    storage,
    db,
    evidence,
    read,
    remaining,
  };
}

async function enumerateCheckpointStores(
  context: ReturnType<typeof createCheckpointInventory>,
  additional: readonly CheckpointStorage[] = [],
): Promise<CheckpointStorage[]> {
  const { read, storage } = context;
  const records = await read(CHECKPOINT_STORAGE_COLLECTION, [
    { $limit: 257 },
    {
      $project: {
        _id: 0,
        record: {
          $cond: [
            { $lte: [{ $bsonSize: '$$ROOT' }, 2048] },
            { _id: '$_id', owner: '$owner', storage: '$storage' },
            { invalid: { $literal: true } },
          ],
        },
      },
    },
  ]);
  if (records.length > 256) failCheckpointInventory();
  const { ttlSeconds: _defaultTtl, ...defaultStorage } = resolveCheckpointerConfig(undefined);
  const stores = new Map<string, CheckpointStorage>();
  for (const entry of [inventoryStorage(defaultStorage), storage, ...additional])
    stores.set(checkpointStorageKey(entry), entry);
  if (stores.size > 32) failCheckpointInventory();
  for (const row of records) {
    if (
      !row ||
      typeof row !== 'object' ||
      !row.record ||
      typeof row.record !== 'object' ||
      Array.isArray(row.record)
    )
      failCheckpointInventory();
    const record = row.record as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(',') !== '_id,owner,storage' ||
      typeof record.owner !== 'string' ||
      !/^lcg:v2:[a-f0-9]{64}:$/.test(record.owner)
    )
      failCheckpointInventory();
    const retained = inventoryStorage(record.storage);
    const key = checkpointStorageKey(retained);
    if (record._id !== `${record.owner}${key}`) failCheckpointInventory();
    stores.set(key, retained);
    if (stores.size > 32) failCheckpointInventory();
  }
  return [...stores.values()];
}

/**
 * Admission-only metadata census, independent of saver startup. Known default/current/registered
 * stores are covered; the caller must separately establish historical configuration lineage.
 * A namespace never registered by a legacy custom saver cannot be inferred from an empty registry.
 */
export async function inspectInitialCheckpointPopulation(
  options: InitialCheckpointPopulationOptions,
): Promise<InitialCheckpointPopulation> {
  const context = createCheckpointInventory(options);
  const {
    observedFrom,
    originalDeadline,
    targetBindingSha256,
    configurationSha256,
    evidence,
    read,
    remaining,
  } = context;
  const stores = await enumerateCheckpointStores(context);
  const names = [
    ...new Set(
      stores.flatMap((entry) => [
        entry.checkpointCollectionName,
        entry.checkpointWritesCollectionName,
      ]),
    ),
  ].sort();
  let recoveryCopies: 0 | 1 = 0;
  for (const name of names) {
    const rows = await read(name, [
      { $limit: 1 },
      { $project: { _id: 0, present: { $literal: 1 } } },
    ]);
    if (
      rows.length > 1 ||
      rows.some((row) => !row || row.present !== 1 || Object.keys(row).length !== 1)
    )
      failCheckpointInventory();
    if (rows.length) recoveryCopies = 1;
  }
  remaining();
  const result: Omit<InitialCheckpointPopulation, 'evidenceSha256'> = {
    schema: 1,
    owner: 'agent-checkpoints',
    originalDeadline,
    observedFrom: new Date(observedFrom).toISOString(),
    observedThrough: new Date().toISOString(),
    targetBindingSha256,
    configurationSha256,
    saturatedCounts: { recoveryCopies },
    complete: recoveryCopies === 0,
  };
  evidence.update(JSON.stringify(result));
  return { ...result, evidenceSha256: evidence.digest('hex') };
}

/** Bounded metadata census only: no saver initialization, DDL, payload decode or row mutation. */
export async function inspectCheckpointIndexPopulation(
  options: CheckpointIndexPopulationOptions,
): Promise<CheckpointIndexPopulation> {
  const context = createCheckpointInventory(options);
  const {
    observedFrom,
    originalDeadline,
    targetBindingSha256,
    configurationSha256,
    evidence,
    read,
    remaining,
  } = context;
  const lineage = options.historicalStorageLineage;
  let historicalLineageSha256: string | null = null;
  let historical: CheckpointStorage[] = [];
  if (lineage !== undefined) {
    if (
      !lineage ||
      typeof lineage !== 'object' ||
      Array.isArray(lineage) ||
      Object.keys(lineage).sort().join(',') !== 'evidenceSha256,stores' ||
      typeof lineage.evidenceSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(lineage.evidenceSha256) ||
      !Array.isArray(lineage.stores) ||
      lineage.stores.length > 32
    )
      failCheckpointInventory();
    historicalLineageSha256 = lineage.evidenceSha256;
    historical = lineage.stores.map(inventoryStorage);
  }
  evidence.update(JSON.stringify([historicalLineageSha256, historical]));
  const stores = await enumerateCheckpointStores(context, historical);
  const names = new Map<string, 'checkpoint' | 'pending'>();
  for (const store of stores) {
    for (const [name, role] of [
      [store.checkpointCollectionName, 'checkpoint'],
      [store.checkpointWritesCollectionName, 'pending'],
    ] as const) {
      if (names.has(name) && names.get(name) !== role) failCheckpointInventory();
      names.set(name, role);
    }
  }
  const count = (value: unknown): number => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
      failCheckpointInventory();
    return value;
  };
  const collections: CheckpointCollectionPopulation[] = [];
  for (const [collection, role] of [...names].sort(([a], [b]) => a.localeCompare(b))) {
    const key =
      role === 'checkpoint'
        ? { thread_id: 1, checkpoint_ns: 1, checkpoint_id: -1 }
        : { thread_id: 1, checkpoint_ns: 1, checkpoint_id: 1, task_id: 1, idx: 1 };
    const fields = Object.keys(key);
    const validKey = {
      $and: [
        ...fields
          .filter((field) => field !== 'idx')
          .map((field) => ({
            $eq: [{ $type: `$${field}` }, 'string'],
          })),
        ...(role === 'pending'
          ? [
              {
                $cond: [
                  { $isNumber: '$idx' },
                  {
                    $and: [
                      { $gte: ['$idx', -Number.MAX_SAFE_INTEGER] },
                      { $lte: ['$idx', Number.MAX_SAFE_INTEGER] },
                      { $eq: ['$idx', { $trunc: '$idx' }] },
                    ],
                  },
                  false,
                ],
              },
            ]
          : []),
      ],
    };
    const totals = await read(collection, [
      {
        $group: {
          _id: null,
          rowCount: { $sum: 1 },
          malformedKeyRows: { $sum: { $cond: [validKey, 0, 1] } },
        },
      },
      { $project: { _id: 0, rowCount: 1, malformedKeyRows: 1 } },
    ]);
    if (totals.length > 1) failCheckpointInventory();
    const rowCount = totals.length ? count(totals[0].rowCount) : 0;
    const malformedKeyRows = totals.length ? count(totals[0].malformedKeyRows) : 0;
    if (malformedKeyRows > rowCount) failCheckpointInventory();
    const duplicates = await read(collection, [
      {
        $group: {
          _id: Object.fromEntries(fields.map((field) => [field, { $ifNull: [`$${field}`, null] }])),
          n: { $sum: 1 },
        },
      },
      { $match: { n: { $gt: 1 } } },
      {
        $group: {
          _id: null,
          duplicateGroups: { $sum: 1 },
          duplicateExcessRows: { $sum: { $subtract: ['$n', 1] } },
        },
      },
      { $project: { _id: 0, duplicateGroups: 1, duplicateExcessRows: 1 } },
    ]);
    if (duplicates.length > 1) failCheckpointInventory();
    const duplicateGroups = duplicates.length ? count(duplicates[0].duplicateGroups) : 0;
    const duplicateExcessRows = duplicates.length ? count(duplicates[0].duplicateExcessRows) : 0;
    if (duplicateGroups > duplicateExcessRows || duplicateExcessRows > rowCount)
      failCheckpointInventory();
    // Project on the server: partial filters, host names and usage statistics never leave Mongo.
    const metadata = await read(collection, [
      { $indexStats: {} },
      { $limit: 65 },
      {
        $project: {
          _id: 0,
          definition: {
            $cond: [
              { $lte: [{ $bsonSize: '$spec' }, 4096] },
              {
                name: '$name',
                key: '$key',
                unique: { $eq: ['$spec.unique', true] },
                building: { $eq: [{ $ifNull: ['$building', false] }, true] },
                sparse: { $eq: ['$spec.sparse', true] },
                partial: { $ne: [{ $type: '$spec.partialFilterExpression' }, 'missing'] },
                collation: {
                  $cond: [
                    { $in: [{ $ifNull: ['$spec.collation.locale', 'simple'] }, ['simple']] },
                    'simple',
                    'other',
                  ],
                },
                expireAfterSeconds: '$spec.expireAfterSeconds',
              },
              { invalid: { $literal: true } },
            ],
          },
        },
      },
    ]);
    if (metadata.length > 64) failCheckpointInventory();
    const indexes = metadata
      .map(({ definition }): CheckpointPhysicalIndex => {
        if (!definition || typeof definition !== 'object' || Array.isArray(definition))
          failCheckpointInventory();
        const index = definition as Record<string, unknown>;
        if (
          typeof index.name !== 'string' ||
          index.name.length > 128 ||
          !index.key ||
          typeof index.key !== 'object' ||
          Array.isArray(index.key) ||
          Object.keys(index.key).length > 32 ||
          Object.entries(index.key).some(
            ([field, direction]) =>
              field.length > 128 ||
              !(
                direction === 1 ||
                direction === -1 ||
                (typeof direction === 'string' &&
                  ['text', 'hashed', '2d', '2dsphere', 'geoHaystack'].includes(direction))
              ),
          ) ||
          typeof index.unique !== 'boolean' ||
          typeof index.building !== 'boolean' ||
          typeof index.sparse !== 'boolean' ||
          typeof index.partial !== 'boolean' ||
          !['simple', 'other'].includes(index.collation as string) ||
          (index.expireAfterSeconds !== undefined &&
            (typeof index.expireAfterSeconds !== 'number' ||
              !Number.isSafeInteger(index.expireAfterSeconds) ||
              index.expireAfterSeconds < 0))
        )
          failCheckpointInventory();
        return index as unknown as CheckpointPhysicalIndex;
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    const expectedName =
      role === 'checkpoint' ? 'lc_checkpoint_slot_unique' : 'lc_pending_slot_unique';
    const physical = indexes.find((index) => index.name === expectedName);
    let indexStatus: CheckpointCollectionPopulation['indexStatus'] = 'missing';
    if (physical) {
      indexStatus =
        physical.unique &&
        !physical.building &&
        !physical.sparse &&
        !physical.partial &&
        physical.collation === 'simple' &&
        physical.expireAfterSeconds === undefined &&
        JSON.stringify(physical.key) === JSON.stringify(key)
          ? 'verified'
          : 'conflicting';
    }
    collections.push({
      collection,
      role,
      rowCount,
      malformedKeyRows,
      duplicateGroups,
      duplicateExcessRows,
      indexes,
      indexStatus,
    });
  }
  remaining();
  const result: Omit<CheckpointIndexPopulation, 'evidenceSha256'> = {
    schema: 1,
    owner: 'agent-checkpoints',
    originalDeadline,
    observedFrom: new Date(observedFrom).toISOString(),
    observedThrough: new Date().toISOString(),
    targetBindingSha256,
    configurationSha256,
    historicalLineageSha256,
    collections,
    complete:
      historicalLineageSha256 !== null &&
      collections.every(
        (collection) =>
          collection.malformedKeyRows === 0 &&
          collection.duplicateGroups === 0 &&
          collection.indexStatus === 'verified',
      ),
  };
  evidence.update(JSON.stringify(result));
  return { ...result, evidenceSha256: evidence.digest('hex') };
}

export function checkpointStorageKey(storage: CheckpointStorage): string {
  const value = JSON.stringify([
    storage.type,
    storage.checkpointCollectionName,
    storage.checkpointWritesCollectionName,
  ]);
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Descriptors locate stores; caller ownership and captured identities authorize deletion. */
export async function checkpointStorageConfigs(
  userId: string,
  tenantId: string | undefined,
  cfg?: TCheckpointerConfig,
): Promise<ResolvedCheckpointerConfig[]> {
  const db = mongoose.connection.db;
  if (!db || mongoose.connection.readyState !== 1)
    throw new Error('Checkpoint database is unavailable');
  const owners = (tenantId ? [tenantId, undefined] : [undefined]).map((tenant) =>
    checkpointOwnerNamespacePrefix(userId, tenant),
  );
  const records = await db
    .collection<CheckpointStorageRecord>(CHECKPOINT_STORAGE_COLLECTION)
    .find({ $or: owners.map((owner) => ({ _id: { $regex: `^${owner}` } })) })
    .toArray();
  const configs = records.map(({ storage }) => resolveCheckpointerConfig(storage));
  configs.push(resolveCheckpointerConfig(cfg));
  return [...new Map(configs.map((storage) => [checkpointStorageKey(storage), storage])).values()];
}

/** Capture exact owner-qualified identities, including orphan payload during owner-wide deletion. */
export async function* ownedCheckpointReferences(
  userId: string,
  tenantId: string | undefined,
  conversationIds: readonly string[] | undefined,
  storage: CheckpointStorage,
): AsyncGenerator<{
  conversationId: string;
  checkpoint: { threadId: string; checkpointNs: string; checkpointId: string };
}> {
  if (storage.type === 'memory') return;
  const db = mongoose.connection.db;
  if (!db || mongoose.connection.readyState !== 1)
    throw new Error('Checkpoint database is unavailable');
  const owners = (tenantId ? [tenantId, undefined] : [undefined]).map((tenant) =>
    checkpointOwnerNamespacePrefix(userId, tenant),
  );
  for (let offset = 0; offset < (conversationIds?.length ?? 1); offset += 64) {
    const logicalIds = new Map<string, string>();
    for (const id of conversationIds?.slice(offset, offset + 64) ?? []) {
      logicalIds.set(id, id);
      for (const owner of owners) logicalIds.set(`${owner}${id}`, id);
    }
    for (const name of [storage.checkpointCollectionName, storage.checkpointWritesCollectionName]) {
      const cursor = db
        .collection<{
          thread_id: string;
          checkpoint_ns: string;
          checkpoint_id: string;
          lc_owner?: string;
        }>(name)
        .find(
          {
            ...(conversationIds == null ? {} : { thread_id: { $in: [...logicalIds.keys()] } }),
            $or: [
              ...owners.map((owner) => ({ checkpoint_ns: { $regex: `^${owner}` } })),
              { lc_owner: { $in: owners } },
            ],
          },
          { projection: { thread_id: 1, checkpoint_ns: 1, checkpoint_id: 1, lc_owner: 1 } },
        );
      for await (const row of cursor) {
        if (typeof row.checkpoint_id !== 'string' || typeof row.checkpoint_ns !== 'string')
          continue;
        const logicalThread =
          row.lc_owner != null &&
          owners.includes(row.lc_owner) &&
          row.thread_id.startsWith(row.lc_owner)
            ? row.thread_id.slice(row.lc_owner.length)
            : row.thread_id;
        yield {
          conversationId: logicalIds.get(row.thread_id) ?? logicalThread,
          checkpoint: {
            threadId: row.thread_id,
            checkpointNs: row.checkpoint_ns,
            checkpointId: row.checkpoint_id,
          },
        };
      }
    }
  }
}
