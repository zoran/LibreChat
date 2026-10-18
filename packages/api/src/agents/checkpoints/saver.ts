import { WRITES_IDX_MAP } from '@langchain/langgraph-checkpoint';
import { MongoDBSaver } from '@langchain/langgraph-checkpoint-mongodb';
import type {
  Checkpoint,
  CheckpointMetadata,
  CheckpointTuple,
  CheckpointListOptions,
  CheckpointPendingWrite,
  PendingWrite,
} from '@langchain/langgraph-checkpoint';
import type { Binary, Document, Filter, UpdateOneModel } from 'mongodb';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { CheckpointStorageRecord } from './storage';
import {
  CHECKPOINT_STORAGE_COLLECTION,
  LIBRECHAT_CHECKPOINT_STORAGE_OWNER_KEY,
  checkpointStorageKey,
} from './storage';
import { SOURCE_FREE, SOURCE_PRESENT } from './source-retention';

export const LIBRECHAT_CHECKPOINT_OWNER_KEY = '__librechat_checkpoint_owner';
export const LIBRECHAT_LEGACY_CHECKPOINT_KEY = '__librechat_legacy_checkpoint_id';
export type CheckpointWriteSession = ReturnType<
  ConstructorParameters<typeof MongoDBSaver>[0]['client']['startSession']
>;

export interface CheckpointRow {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  parent_checkpoint_id?: string;
  lc_owner?: string;
  type: string;
  checkpoint: Binary;
  metadata: Binary;
  metadata_search: CheckpointMetadata;
}

export interface WriteRow {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  task_id: string;
  idx: number;
  channel: string;
  type: string;
  value: Binary;
  lc_owner?: string;
}

function ownerOf(config: RunnableConfig): string | undefined {
  const owner = config.configurable?.[LIBRECHAT_CHECKPOINT_OWNER_KEY];
  return typeof owner === 'string' && owner.length > 0 ? owner : undefined;
}

function identity(config: RunnableConfig): {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id?: string;
} {
  const thread_id = config.configurable?.thread_id;
  const checkpoint_ns = config.configurable?.checkpoint_ns ?? '';
  const checkpoint_id = config.configurable?.checkpoint_id;
  if (
    typeof thread_id !== 'string' ||
    typeof checkpoint_ns !== 'string' ||
    (checkpoint_id != null && typeof checkpoint_id !== 'string')
  ) {
    throw new Error('Invalid owned checkpoint identity');
  }
  return { thread_id, checkpoint_ns, ...(checkpoint_id == null ? {} : { checkpoint_id }) };
}

function logicalReference(doc: CheckpointRow, owner?: string) {
  const namespace =
    owner != null && doc.checkpoint_ns.startsWith(owner)
      ? doc.checkpoint_ns.slice(owner.length)
      : doc.checkpoint_ns;
  return {
    thread_id:
      owner != null && doc.thread_id.startsWith(owner)
        ? doc.thread_id.slice(owner.length)
        : doc.thread_id,
    checkpoint_ns: namespace,
    checkpoint_id: doc.checkpoint_id,
  };
}

/** Mirrors the installed SDK's optional string-config contract for unowned reads. */
function nativeStringConfig(name: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`Invalid configurable.${name}: expected a string`);
  return value;
}

/** No source-bearing row may reach Serde until the complete source authorization exists here. */
function requireSourceFree(row: CheckpointRow | WriteRow): void {
  for (const field of [
    'lc_source_binding',
    'lc_source_file_ids',
    'lc_source_expires_at',
    'lc_retained_allocations',
  ]) {
    if (Object.prototype.hasOwnProperty.call(row, field))
      throw new Error('Source-bound checkpoint reads require source authorization');
  }
}

/** Isolate physical storage by owner while preserving logical SDK references. */
export class OwnedMongoSaver extends MongoDBSaver {
  /** Raw native deletion has no source liability authority; concurrent markers also prevent deletion. */
  override async deleteThread(threadId: string): Promise<void> {
    if (typeof threadId !== 'string') throw new Error('Invalid threadId: expected a string');
    const names = [this.checkpointCollectionName, this.checkpointWritesCollectionName];
    const requireOrdinary = async (): Promise<void> => {
      for (const name of names) {
        if (
          await this.db
            .collection(name)
            .countDocuments({ thread_id: threadId, ...SOURCE_PRESENT }, { limit: 1 })
        )
          throw new Error('Source-bound checkpoint deletion requires quota-aware cleanup');
      }
    };
    await requireOrdinary();
    for (const name of names)
      await this.db.collection(name).deleteMany({ thread_id: threadId, ...SOURCE_FREE });
    await requireOrdinary();
  }

  /** Full physical slots are unique for every writer, including native unowned callers. */
  protected async ensureWriteIndexes(): Promise<void> {
    for (const [name, key, indexName] of [
      [
        this.checkpointCollectionName,
        { thread_id: 1, checkpoint_ns: 1, checkpoint_id: -1 },
        'lc_checkpoint_slot_unique',
      ],
      [
        this.checkpointWritesCollectionName,
        { thread_id: 1, checkpoint_ns: 1, checkpoint_id: 1, task_id: 1, idx: 1 },
        'lc_pending_slot_unique',
      ],
    ] as const) {
      const collection = this.db.collection(name);
      await collection.createIndex(key, {
        name: indexName,
        unique: true,
        collation: { locale: 'simple' },
      });
      const index = (await collection.indexes()).find((candidate) => candidate.name === indexName);
      if (
        !index ||
        index.unique !== true ||
        index.sparse ||
        index.partialFilterExpression ||
        JSON.stringify(index.key) !== JSON.stringify(key) ||
        (index.collation && index.collation.locale !== 'simple')
      ) {
        throw new Error('Checkpoint physical slot uniqueness is unverified');
      }
    }
  }

  override async setup(): Promise<Error[]> {
    const errors = await super.setup();
    if (errors.length > 0) return errors;
    try {
      await this.ensureWriteIndexes();
    } catch (error) {
      errors.push(error as Error);
    }
    return errors;
  }

  /** Ordinary writes cannot mutate marked rows; uniqueness also prevents an uncharged duplicate. */
  protected async persistRows(
    collectionName: string,
    operations: readonly UpdateOneModel<Document>[],
    session?: CheckpointWriteSession,
  ): Promise<void> {
    if (!operations.length) return;
    await this.db.collection(collectionName).bulkWrite(
      operations.map((operation) => ({
        updateOne: {
          ...operation,
          filter: { $and: [operation.filter, SOURCE_FREE] },
          collation: { locale: 'simple' },
        },
      })),
      session ? { session } : {},
    );
  }

  /** Ordinary/HITL saves remain unchanged; durable runs may fence the actual writes. */
  protected withWriteSession<T>(
    _config: RunnableConfig,
    write: (session?: CheckpointWriteSession) => Promise<T>,
  ): Promise<T> {
    return write();
  }

  private async recordStorage(
    config: RunnableConfig,
    session?: CheckpointWriteSession,
  ): Promise<void> {
    const namespace = config.configurable?.checkpoint_ns;
    const candidate =
      ownerOf(config) ??
      (typeof namespace === 'string' ? namespace.match(/^lcg:v2:[0-9a-f]{64}:/)?.[0] : undefined) ??
      config.configurable?.[LIBRECHAT_CHECKPOINT_STORAGE_OWNER_KEY];
    if (typeof candidate !== 'string' || !/^lcg:v2:[0-9a-f]{64}:$/.test(candidate)) return;
    const storage = {
      type: 'mongo' as const,
      checkpointCollectionName: this.checkpointCollectionName,
      checkpointWritesCollectionName: this.checkpointWritesCollectionName,
    };
    await this.db
      .collection<CheckpointStorageRecord>(CHECKPOINT_STORAGE_COLLECTION)
      .updateOne(
        { _id: `${candidate}${checkpointStorageKey(storage)}` },
        { $setOnInsert: { owner: candidate, storage } },
        { upsert: true, ...(session && { session }) },
      );
  }

  private async tuple(
    doc: CheckpointRow,
    owner?: string,
    legacy = false,
    listed = false,
  ): Promise<CheckpointTuple> {
    const key = logicalReference(doc, owner);
    const namespace = key.checkpoint_ns;
    const rows = await this.db
      .collection<WriteRow>(this.checkpointWritesCollectionName)
      .find(
        owner == null
          ? key
          : {
              checkpoint_id: key.checkpoint_id,
              $or: [
                {
                  thread_id: `${owner}${key.thread_id}`,
                  checkpoint_ns: `${owner}${namespace}`,
                  lc_owner: owner,
                },
                ...(legacy
                  ? [
                      {
                        thread_id: key.thread_id,
                        checkpoint_ns: namespace,
                        lc_owner: { $exists: false },
                      },
                    ]
                  : []),
              ],
            },
      )
      .toArray();
    requireSourceFree(doc);
    // Even a legacy duplicate that loses its slot must be checked before any decode starts.
    for (const row of rows) requireSourceFree(row);
    return this.decodeTuple(doc, rows, owner, legacy, listed);
  }

  /** Decode only detached, already authorized rows; source reads supply a live deadline guard. */
  protected async decodeTuple(
    doc: CheckpointRow,
    rows: WriteRow[],
    owner?: string,
    legacy = false,
    listed = false,
    assertReadable: () => void = () => {},
  ): Promise<CheckpointTuple> {
    const key = logicalReference(doc, owner);
    const namespace = key.checkpoint_ns;
    const decode = (type: string, bytes: Uint8Array) => {
      assertReadable();
      return this.serde.loadsTyped(type, bytes);
    };
    let pendingRows: WriteRow[] = rows;
    if (owner != null) {
      const slots = new Map<string, WriteRow>();
      for (const row of rows) {
        const slot = JSON.stringify([row.task_id, row.idx]);
        if (!slots.has(slot) || row.checkpoint_ns === `${owner}${namespace}`) slots.set(slot, row);
      }
      pendingRows = [...slots.values()];
    }
    // Preserve the installed SDK's decode order, after the shared raw-row guard.
    const checkpoint =
      owner == null ? ((await decode(doc.type, doc.checkpoint.value())) as Checkpoint) : undefined;
    const metadata =
      owner == null && listed
        ? ((await decode(doc.type, doc.metadata.value())) as CheckpointMetadata)
        : undefined;
    const pendingWrites: CheckpointPendingWrite[] = await Promise.all(
      pendingRows.map(
        async (row) =>
          [
            row.task_id,
            row.channel,
            await decode(row.type, row.value.value()),
          ] as CheckpointPendingWrite,
      ),
    );
    const hasParent =
      owner == null && listed
        ? Boolean(doc.parent_checkpoint_id)
        : doc.parent_checkpoint_id != null;
    const parentConfig = hasParent
      ? {
          configurable: {
            ...key,
            checkpoint_id: doc.parent_checkpoint_id,
            ...(owner == null
              ? {}
              : {
                  [LIBRECHAT_CHECKPOINT_OWNER_KEY]: owner,
                  [LIBRECHAT_LEGACY_CHECKPOINT_KEY]: doc.parent_checkpoint_id,
                }),
          },
        }
      : undefined;
    const tuple: CheckpointTuple = {
      config: {
        configurable: {
          ...key,
          ...(owner == null ? {} : { [LIBRECHAT_CHECKPOINT_OWNER_KEY]: owner }),
          ...(legacy ? { [LIBRECHAT_LEGACY_CHECKPOINT_KEY]: doc.checkpoint_id } : {}),
        },
      },
      checkpoint:
        owner == null
          ? checkpoint!
          : ((await decode(doc.type, doc.checkpoint.value())) as Checkpoint),
      metadata:
        owner == null && listed
          ? metadata!
          : ((await decode(doc.type, doc.metadata.value())) as CheckpointMetadata),
      pendingWrites,
      ...(owner == null || hasParent ? { parentConfig } : {}),
    };
    assertReadable();
    return tuple;
  }

  override async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const owner = ownerOf(config);
    if (owner == null) {
      const thread_id = nativeStringConfig('thread_id', config.configurable?.thread_id);
      if (thread_id === undefined) return undefined;
      const checkpoint_ns =
        nativeStringConfig('checkpoint_ns', config.configurable?.checkpoint_ns) ?? '';
      const checkpoint_id = nativeStringConfig('checkpoint_id', config.configurable?.checkpoint_id);
      const doc = await this.db
        .collection<CheckpointRow>(this.checkpointCollectionName)
        .find({ thread_id, checkpoint_ns, ...(checkpoint_id ? { checkpoint_id } : {}) })
        .sort({ checkpoint_id: -1 })
        .limit(1)
        .next();
      return doc == null ? undefined : this.tuple(doc);
    }
    const key = identity(config);
    const checkpoints = this.db.collection<CheckpointRow>(this.checkpointCollectionName);
    let doc = await checkpoints
      .find({
        ...key,
        thread_id: `${owner}${key.thread_id}`,
        checkpoint_ns: `${owner}${key.checkpoint_ns}`,
        lc_owner: owner,
      })
      .sort({ checkpoint_id: -1 })
      .limit(1)
      .next();
    if (
      doc == null &&
      key.checkpoint_id != null &&
      key.checkpoint_id === config.configurable?.[LIBRECHAT_LEGACY_CHECKPOINT_KEY]
    ) {
      doc = await checkpoints.findOne({ ...key, lc_owner: { $exists: false } });
    }
    return doc == null
      ? undefined
      : this.tuple(
          doc,
          owner,
          key.checkpoint_id != null &&
            key.checkpoint_id === config.configurable?.[LIBRECHAT_LEGACY_CHECKPOINT_KEY],
        );
  }

  override async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    const owner = ownerOf(config);
    let query: Filter<CheckpointRow>;
    if (owner == null) {
      const thread_id = nativeStringConfig('thread_id', config.configurable?.thread_id);
      const checkpoint_ns = nativeStringConfig('checkpoint_ns', config.configurable?.checkpoint_ns);
      query = {
        ...(thread_id ? { thread_id } : {}),
        ...(checkpoint_ns === undefined ? {} : { checkpoint_ns }),
      };
    } else {
      const key = identity(config);
      query = {
        thread_id: `${owner}${key.thread_id}`,
        checkpoint_ns: `${owner}${key.checkpoint_ns}`,
        lc_owner: owner,
      };
    }
    for (const [name, value] of Object.entries(options?.filter ?? {})) {
      if (value !== null && typeof value === 'object')
        throw new Error('Checkpoint metadata filters must be primitive');
      query[`metadata_search.${name}`] = value;
    }
    const before = options?.before?.configurable?.checkpoint_id;
    if (owner == null ? before !== undefined : before != null) {
      if (owner != null && typeof before !== 'string')
        throw new Error('Invalid checkpoint list boundary');
      query.checkpoint_id = { $lt: nativeStringConfig('checkpoint_id', before)! };
    }
    let cursor = this.db
      .collection<CheckpointRow>(this.checkpointCollectionName)
      .find(query)
      .sort({ checkpoint_id: -1 });
    if (owner == null ? options?.limit !== undefined : options?.limit != null)
      cursor = cursor.limit(options!.limit!);
    for await (const doc of cursor) yield await this.tuple(doc, owner, false, true);
  }

  override async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
  ): Promise<RunnableConfig> {
    const owner = ownerOf(config);
    if (owner == null) {
      for (const name of ['thread_id', 'checkpoint_ns', 'checkpoint_id'])
        nativeStringConfig(name, config.configurable?.[name]);
    }
    const key = identity(config);
    const [[type, serializedCheckpoint], [metadataType, serializedMetadata]] = await Promise.all([
      this.serde.dumpsTyped(checkpoint),
      this.serde.dumpsTyped(metadata),
    ]);
    if (type !== metadataType) throw new Error('Mismatched checkpoint and metadata types');
    const stored = {
      thread_id: key.thread_id,
      checkpoint_ns: key.checkpoint_ns,
      checkpoint_id: checkpoint.id,
    };
    await this.ensureWriteIndexes();
    await this.withWriteSession(config, async (session) => {
      await this.recordStorage(config, session);
      await this.persistRows(
        this.checkpointCollectionName,
        [
          {
            filter: {
              ...stored,
              ...(owner == null
                ? {}
                : {
                    thread_id: `${owner}${key.thread_id}`,
                    checkpoint_ns: `${owner}${key.checkpoint_ns}`,
                    lc_owner: owner,
                  }),
            },
            update: {
              $set: {
                parent_checkpoint_id: key.checkpoint_id,
                type,
                checkpoint: serializedCheckpoint,
                metadata: serializedMetadata,
                metadata_search: metadata,
              },
              ...(this.enableTimestamps ? { $currentDate: { upserted_at: true as const } } : {}),
            },
            upsert: true,
          },
        ],
        session,
      );
    });
    return {
      configurable: {
        ...stored,
        ...(owner == null ? {} : { [LIBRECHAT_CHECKPOINT_OWNER_KEY]: owner }),
      },
    };
  }

  override async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
  ): Promise<void> {
    const owner = ownerOf(config);
    if (owner == null) {
      for (const name of ['thread_id', 'checkpoint_ns', 'checkpoint_id']) {
        if (nativeStringConfig(name, config.configurable?.[name]) === undefined)
          throw new Error(`Missing configurable.${name}`);
      }
    }
    const key = identity(config);
    if (key.checkpoint_id == null) throw new Error('Owned writes require a checkpoint id');
    const allSpecial = writes.every(([channel]) => channel in WRITES_IDX_MAP);
    const legacy =
      owner != null && key.checkpoint_id === config.configurable?.[LIBRECHAT_LEGACY_CHECKPOINT_KEY];
    const existing =
      !allSpecial && legacy
        ? await this.db
            .collection<WriteRow>(this.checkpointWritesCollectionName)
            .find(
              { ...key, task_id: taskId, lc_owner: { $exists: false } },
              { projection: { idx: 1 } },
            )
            .toArray()
        : [];
    const legacySlots = new Set(existing.map((row) => row.idx));
    const operations = await Promise.all(
      writes.map(async ([channel, value], idx): Promise<UpdateOneModel<Document> | null> => {
        if (legacySlots.has(WRITES_IDX_MAP[channel] ?? idx)) return null;
        const [type, serializedValue] = await this.serde.dumpsTyped(value);
        const fields = {
          channel,
          type,
          value: serializedValue,
          ...(owner == null ? {} : { lc_owner: owner }),
        };
        return {
          filter: {
            ...key,
            ...(owner == null
              ? {}
              : {
                  thread_id: `${owner}${key.thread_id}`,
                  checkpoint_ns: `${owner}${key.checkpoint_ns}`,
                  lc_owner: owner,
                }),
            task_id: taskId,
            idx: WRITES_IDX_MAP[channel] ?? idx,
          },
          update: allSpecial
            ? {
                $set: fields,
                ...(this.enableTimestamps ? { $currentDate: { upserted_at: true as const } } : {}),
              }
            : {
                $setOnInsert: {
                  ...fields,
                  ...(this.enableTimestamps ? { upserted_at: new Date() } : {}),
                },
              },
          upsert: true,
        };
      }),
    );
    await this.ensureWriteIndexes();
    await this.withWriteSession(config, async (session) => {
      await this.recordStorage(config, session);
      await this.persistRows(
        this.checkpointWritesCollectionName,
        operations.filter((operation): operation is UpdateOneModel<Document> => operation != null),
        session,
      );
    });
  }
}
