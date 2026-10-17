import mongoose from 'mongoose';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  logger,
  SYSTEM_TENANT_ID,
  createGenerationAdmissionMethods,
  snapshotGenerationCheckpointAdmission,
} from '@librechat/data-schemas';
import type {
  Checkpoint,
  CheckpointListOptions,
  CheckpointMetadata,
  CheckpointTuple,
  PendingWrite,
} from '@langchain/langgraph-checkpoint';
import type { GenerationAdmissionInput, GenerationAdmissionMethods } from '@librechat/data-schemas';
import type { MongoDBSaverParams } from '@langchain/langgraph-checkpoint-mongodb';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { CheckpointWriteSession } from './saver';
import {
  LIBRECHAT_CHECKPOINT_NAMESPACE_KEY,
  toStorageCheckpointConfig,
  fromStorageCheckpointConfig,
  fromStorageCheckpointTuple,
} from './namespace';
import {
  checkpointNamespaceBelongsToOwner,
  checkpointOwnerNamespacePrefix,
} from '../../stream/checkpoints';
import {
  OwnedMongoSaver,
  LIBRECHAT_CHECKPOINT_OWNER_KEY,
  LIBRECHAT_LEGACY_CHECKPOINT_KEY,
} from './saver';
import { LIBRECHAT_CHECKPOINT_STORAGE_OWNER_KEY } from './storage';

/**
 * MongoDB's hard per-document ceiling. A checkpoint whose serialized state pushes its
 * document past this cannot be stored — the driver throws `BSONObjectTooLarge` (code 10334).
 */
const MAX_BSON_DOCUMENT_BYTES = 16 * 1024 * 1024;

/**
 * Headroom reserved below {@link MAX_BSON_DOCUMENT_BYTES} for a checkpoint document's
 * non-state fields (ids, metadata, `metadata_search`, BSON framing). The serialized
 * `checkpoint` blob dominates the document; this margin covers everything else so the guard
 * rejects before Mongo does — with a legible error instead of a raw driver failure.
 */
const CHECKPOINT_SIZE_HEADROOM_BYTES = 1024 * 1024;

/**
 * Reject a checkpoint whose serialized state exceeds this. The pause is unrecoverable either
 * way (the document can't be written), so failing here as a typed {@link CheckpointTooLargeError}
 * turns an opaque `BSONObjectTooLarge` crash into an actionable one.
 */
export const CHECKPOINT_HARD_LIMIT_BYTES: number =
  MAX_BSON_DOCUMENT_BYTES - CHECKPOINT_SIZE_HEADROOM_BYTES;

/**
 * Warn once a persisted checkpoint crosses this soft threshold (~50% of the ceiling), so a
 * conversation's checkpoint growth is visible in logs well before it reaches the hard limit.
 */
export const CHECKPOINT_WARN_BYTES: number = 8 * 1024 * 1024;

/**
 * A durable checkpoint whose serialized state exceeds {@link CHECKPOINT_HARD_LIMIT_BYTES} — more
 * than MongoDB can hold in a single document. Thrown BEFORE the doomed write so the run fails
 * with a clear, typed message instead of a raw driver `BSONObjectTooLarge`. The checkpoint cannot
 * be persisted regardless of how it is handled upstream, so a durable resume is impossible.
 */
export class CheckpointTooLargeError extends Error {
  readonly code = 'CHECKPOINT_TOO_LARGE';
  constructor(
    readonly bytes: number,
    readonly limit: number,
    readonly threadId?: string,
  ) {
    const mb = (n: number): string => (n / 1024 / 1024).toFixed(1);
    super(
      `Checkpoint state is ${mb(bytes)} MB, over the ${mb(limit)} MB durable limit. ` +
        'This conversation carries too much state to resume — large tool outputs or inlined ' +
        'media are the usual cause. Start a new conversation or reduce context.',
    );
    this.name = 'CheckpointTooLargeError';
  }
}

/** Trusted native run binding; this is not a substitute for the caller's ACL/claim checks. */
export interface DurableAgentCheckpointScope {
  userId: string;
  tenantId?: string;
  threadId: string;
  checkpointNamespace: string;
}

export type DurableMongoSaverOptions = MongoDBSaverParams & {
  scope: DurableAgentCheckpointScope;
  admission?: GenerationAdmissionInput;
  warnBytes?: number;
  hardLimitBytes?: number;
};

function dataRecord(value: unknown): Record<string, unknown> {
  if (
    value == null ||
    typeof value !== 'object' ||
    ![null, Object.prototype].includes(Object.getPrototypeOf(value)) ||
    Object.getOwnPropertySymbols(value).length > 0
  ) {
    throw new Error('Invalid durable checkpoint configuration');
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!('value' in descriptor)) throw new Error('Checkpoint configuration must be plain data');
    result[key] = descriptor.value;
  }
  return result;
}

function validIdentity(value: unknown, allowEmpty = false): value is string {
  return (
    typeof value === 'string' &&
    (allowEmpty || value.length > 0) &&
    value.length <= 4096 &&
    !Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  );
}

function snapshotScope(value: DurableAgentCheckpointScope): Readonly<DurableAgentCheckpointScope> {
  const scope = dataRecord(value);
  if (
    Object.keys(scope).some(
      (key) => !['userId', 'tenantId', 'threadId', 'checkpointNamespace'].includes(key),
    ) ||
    !validIdentity(scope.userId) ||
    !validIdentity(scope.threadId) ||
    (scope.tenantId !== undefined && !validIdentity(scope.tenantId)) ||
    !checkpointNamespaceBelongsToOwner(
      scope.checkpointNamespace,
      scope.userId,
      scope.tenantId as string | undefined,
    )
  ) {
    throw new Error('Invalid durable checkpoint scope');
  }
  return Object.freeze({
    userId: scope.userId,
    ...(scope.tenantId === undefined ? {} : { tenantId: scope.tenantId as string }),
    threadId: scope.threadId,
    checkpointNamespace: scope.checkpointNamespace as string,
  });
}

/**
 * Persist every native LangGraph checkpoint and pending write within one immutable
 * owner/thread/generation. Mongo, serde, pending-write slots and retention stay with
 * OwnedMongoSaver; unlike LazyMongoSaver, there is no exit-only buffering here.
 */
export class DurableMongoSaver extends OwnedMongoSaver {
  private readonly scope: Readonly<DurableAgentCheckpointScope>;
  private readonly owner: string;
  private readonly hardLimitBytes: number;
  private readonly warnBytes: number;
  private readonly admission?: Readonly<GenerationAdmissionInput>;
  private readonly admissionMethods?: GenerationAdmissionMethods;
  private writeTail: Promise<void> = Promise.resolve();
  private writesHeld = false;
  private readonly serializationBudget = new AsyncLocalStorage<{ bytes: number } | undefined>();

  constructor(options: DurableMongoSaverOptions) {
    // Capture the caller's scope before any async setup or database work.
    const scope = snapshotScope(options.scope);
    const admission =
      options.admission === undefined
        ? undefined
        : snapshotGenerationCheckpointAdmission(options.admission);
    if (admission) {
      const tenant =
        scope.tenantId && scope.tenantId !== SYSTEM_TENANT_ID
          ? scope.tenantId
          : '__single_tenant__';
      if (
        admission.principalId !== scope.userId ||
        admission.tenantId !== tenant ||
        admission.conversationId !== scope.threadId ||
        admission.continuation!.threadId !== scope.threadId ||
        admission.continuation!.checkpointNamespace !== scope.checkpointNamespace ||
        options.client !== (mongoose.connection.getClient() as unknown) ||
        options.dbName !== mongoose.connection.db?.databaseName
      ) {
        throw new Error(
          'Durable checkpoint admission does not match its owner or Mongo connection',
        );
      }
    }
    const hardLimitBytes = options.hardLimitBytes ?? CHECKPOINT_HARD_LIMIT_BYTES;
    const warnBytes = options.warnBytes ?? Math.min(CHECKPOINT_WARN_BYTES, hardLimitBytes);
    if (
      !Number.isSafeInteger(hardLimitBytes) ||
      hardLimitBytes <= 0 ||
      hardLimitBytes > CHECKPOINT_HARD_LIMIT_BYTES ||
      !Number.isSafeInteger(warnBytes) ||
      warnBytes < 0 ||
      warnBytes > hardLimitBytes
    ) {
      throw new Error('Invalid durable checkpoint size limits');
    }
    super(options);
    this.scope = scope;
    this.admission = admission;
    this.admissionMethods = admission ? createGenerationAdmissionMethods(mongoose) : undefined;
    this.owner = checkpointOwnerNamespacePrefix(scope.userId, scope.tenantId);
    this.hardLimitBytes = hardLimitBytes;
    this.warnBytes = warnBytes;
    const serde = this.serde;
    this.serde = {
      loadsTyped: (type, bytes) => serde.loadsTyped(type, bytes),
      dumpsTyped: async (value) => {
        const serialized = await serde.dumpsTyped(value);
        const budget = this.serializationBudget.getStore();
        const bytes = budget
          ? (budget.bytes += serialized[1].byteLength)
          : serialized[1].byteLength;
        this.assertFits(bytes);
        return serialized;
      },
    };
  }

  protected override async withWriteSession<T>(
    config: RunnableConfig,
    write: (session?: CheckpointWriteSession) => Promise<T>,
  ): Promise<T> {
    if (!this.admission || !this.admissionMethods) return super.withWriteSession(config, write);
    const admission = this.admission;
    const methods = this.admissionMethods;
    // LangGraph submits pending writes concurrently. Serialize only their database
    // transactions; the native admission remains the cross-process authority.
    const operation = this.writeTail.then(async () => {
      if (this.writesHeld) throw new Error('Durable checkpoint writes are held after failure');
      try {
        // Construction verifies the same client/db despite separate driver minor types.
        const result = await methods.writeGenerationCheckpoint(admission, (session) =>
          write(session as unknown as CheckpointWriteSession),
        );
        if (!result.ok)
          throw new Error('Durable checkpoint writer no longer holds confirmed admission');
        return result.value;
      } catch (error) {
        this.writesHeld = true;
        throw error;
      }
    });
    this.writeTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private assertFits(bytes: number): void {
    if (bytes > this.hardLimitBytes) {
      throw new CheckpointTooLargeError(bytes, this.hardLimitBytes, this.scope.threadId);
    }
    if (bytes >= this.warnBytes) {
      logger.warn('[checkpointer] Durable checkpoint state approaches its document limit', {
        bytes,
        limit: this.hardLimitBytes,
      });
    }
  }

  private bind(config: RunnableConfig): RunnableConfig {
    const copy = dataRecord(config);
    const configurable = dataRecord(copy.configurable);
    if (
      configurable.thread_id !== this.scope.threadId ||
      Object.prototype.hasOwnProperty.call(configurable, LIBRECHAT_LEGACY_CHECKPOINT_KEY)
    ) {
      throw new Error('Durable checkpoint scope mismatch or legacy fallback');
    }
    for (const [key, expected] of [
      [LIBRECHAT_CHECKPOINT_OWNER_KEY, this.owner],
      [LIBRECHAT_CHECKPOINT_STORAGE_OWNER_KEY, this.owner],
      [LIBRECHAT_CHECKPOINT_NAMESPACE_KEY, this.scope.checkpointNamespace],
    ]) {
      if (
        Object.prototype.hasOwnProperty.call(configurable, key) &&
        configurable[key] !== expected
      ) {
        throw new Error('Durable checkpoint scope mismatch');
      }
    }
    const graphNamespace = configurable.checkpoint_ns ?? '';
    if (
      !validIdentity(graphNamespace, true) ||
      (configurable.checkpoint_id != null && !validIdentity(configurable.checkpoint_id))
    ) {
      throw new Error('Invalid durable checkpoint reference');
    }
    return {
      ...copy,
      configurable: {
        ...configurable,
        thread_id: this.scope.threadId,
        checkpoint_ns: graphNamespace,
        [LIBRECHAT_CHECKPOINT_OWNER_KEY]: this.owner,
        [LIBRECHAT_CHECKPOINT_NAMESPACE_KEY]: this.scope.checkpointNamespace,
      },
    };
  }

  private restore(tuple: CheckpointTuple, requested: RunnableConfig): CheckpointTuple {
    const restored = fromStorageCheckpointTuple(tuple, requested);
    // OwnedMongoSaver includes a legacy marker in parent references even for owned
    // rows. These rows never use legacy fallback: keep the native parent id only.
    for (const config of [restored.config, restored.parentConfig]) {
      if (config?.configurable) delete config.configurable[LIBRECHAT_LEGACY_CHECKPOINT_KEY];
    }
    return restored;
  }

  override async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const bound = this.bind(config);
    const tuple = await super.getTuple(toStorageCheckpointConfig(bound));
    return tuple == null ? undefined : this.restore(tuple, bound);
  }

  override async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    const bound = this.bind(config);
    const copy = options == null ? {} : dataRecord(options);
    const before = copy.before == null ? undefined : this.bind(copy.before as RunnableConfig);
    if (before && before.configurable!.checkpoint_ns !== bound.configurable!.checkpoint_ns) {
      throw new Error('Checkpoint list boundary belongs to another graph');
    }
    if (copy.limit != null && (!Number.isSafeInteger(copy.limit) || (copy.limit as number) <= 0)) {
      throw new Error('Invalid checkpoint list limit');
    }
    const filter = copy.filter == null ? undefined : dataRecord(copy.filter);
    for (const [key, value] of Object.entries(filter ?? {})) {
      if (
        !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(key) ||
        !(value === null || ['string', 'boolean', 'number'].includes(typeof value)) ||
        (typeof value === 'number' && !Number.isFinite(value))
      ) {
        throw new Error('Invalid checkpoint metadata filter');
      }
    }
    for await (const tuple of super.list(toStorageCheckpointConfig(bound), {
      ...(before && { before: toStorageCheckpointConfig(before) }),
      ...(copy.limit == null ? {} : { limit: copy.limit as number }),
      ...(filter && { filter }),
    })) {
      yield this.restore(tuple, bound);
    }
  }

  override async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
  ): Promise<RunnableConfig> {
    const bound = this.bind(config);
    const checkpointCopy = dataRecord(checkpoint) as unknown as Checkpoint;
    if (!validIdentity(checkpointCopy.id)) throw new Error('Invalid checkpoint id');
    const metadataCopy = dataRecord(metadata) as CheckpointMetadata;
    const bytes = mongoose.mongo.BSON.calculateObjectSize(metadataCopy);
    this.assertFits(bytes);
    // Count both serialized blobs plus metadata_search in the same document. The
    // async-local budget isolates simultaneous supersteps without serializing twice.
    const saved = await this.serializationBudget.run({ bytes }, () =>
      super.put(toStorageCheckpointConfig(bound), checkpointCopy, metadataCopy),
    );
    return fromStorageCheckpointConfig(saved, bound);
  }

  override async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
  ): Promise<void> {
    const bound = this.bind(config);
    if (!validIdentity(bound.configurable?.checkpoint_id) || !validIdentity(taskId)) {
      throw new Error('Pending writes require checkpoint and task ids');
    }
    if (!Array.isArray(writes)) throw new Error('Invalid pending writes');
    const copy = writes.map((write): PendingWrite => {
      if (!Array.isArray(write) || write.length !== 2 || !validIdentity(write[0])) {
        throw new Error('Invalid pending write');
      }
      return [write[0], write[1]];
    });
    // Each pending write is a separate BSON document; check each actual serde
    // result, not the sum of an otherwise valid batch of independent documents.
    await this.serializationBudget.run(undefined, () =>
      super.putWrites(toStorageCheckpointConfig(bound), copy, taskId),
    );
  }

  override async deleteThread(_threadId: string): Promise<void> {
    throw new Error('Use the authenticated native checkpoint deletion owner');
  }
}
