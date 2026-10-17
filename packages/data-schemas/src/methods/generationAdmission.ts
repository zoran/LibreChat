import type { ClientSession, FilterQuery } from 'mongoose';
import type {
  GenerationAdmissionKey,
  GenerationAdmissionSuccessor,
  GenerationAdmissionInput,
  GenerationAdmissionRecord,
  GenerationAdmissionMethods,
  GenerationAdmissionTerminal,
  GenerationAdmissionFailureCode,
  GenerationAdmissionResult,
  GenerationCheckpointBinding,
  GenerationCheckpointRecoveryEvidence,
} from '~/types/generationAdmission';
import { createGenerationAdmissionModel } from '~/models/generationAdmission';

/** Unexpected storage failures expose a safe code, never database/query/credential text. */
export class GenerationAdmissionStorageError extends Error {
  readonly code = 'GENERATION_ADMISSION_STORAGE_ERROR';
  constructor() {
    super('Generation admission storage unavailable');
    this.name = 'GenerationAdmissionStorageError';
  }
}
const writeConcern = { w: 'majority' as const, j: true };
const sha256 = /^[a-f0-9]{64}$/;
const text = (value: string): boolean =>
  typeof value === 'string' && value.length > 0 && value.length <= 256;
const failure = (code: GenerationAdmissionFailureCode): GenerationAdmissionResult<never> => ({
  ok: false,
  error: { code },
});
function key(input: GenerationAdmissionKey): GenerationAdmissionKey {
  return {
    tenantId: input.tenantId,
    principalId: input.principalId,
    clientRequestId: input.clientRequestId,
  };
}
function validKey(input: GenerationAdmissionKey): boolean {
  return !!input && Object.values(key(input)).every(text);
}
function valid(input: GenerationAdmissionInput): boolean {
  return (
    validKey(input) &&
    [
      input.conversationId,
      input.protocol,
      input.ownerInstanceId,
      input.processBootId,
      input.segmentId,
    ].every(text) &&
    typeof input.requestFingerprint === 'string' &&
    sha256.test(input.requestFingerprint) &&
    Number.isSafeInteger(input.generationEpoch) &&
    input.generationEpoch >= 0 &&
    (input.continuation === undefined ||
      (validContinuation(input.continuation) &&
        input.continuation.threadId === input.conversationId))
  );
}
function validContinuation(value: GenerationCheckpointBinding): boolean {
  return (
    !!value &&
    value.version === 1 &&
    value.mode === 'checkpoint-only-v1' &&
    [value.runId, value.threadId, value.checkpointNamespace].every(text) &&
    typeof value.graphFingerprint === 'string' &&
    sha256.test(value.graphFingerprint) &&
    typeof value.policyFingerprint === 'string' &&
    sha256.test(value.policyFingerprint) &&
    (value.sourceBindingSha256 === undefined ||
      (typeof value.sourceBindingSha256 === 'string' &&
        value.sourceBindingSha256.length === 64 &&
        sha256.test(value.sourceBindingSha256)))
  );
}
function continuation(value: GenerationCheckpointBinding): GenerationCheckpointBinding {
  return {
    version: value.version,
    runId: value.runId,
    threadId: value.threadId,
    checkpointNamespace: value.checkpointNamespace,
    graphFingerprint: value.graphFingerprint,
    policyFingerprint: value.policyFingerprint,
    mode: value.mode,
    ...(value.sourceBindingSha256 === undefined
      ? {}
      : { sourceBindingSha256: value.sourceBindingSha256 }),
  };
}
function fence(input: GenerationAdmissionInput): GenerationAdmissionInput {
  const binding = input.continuation;
  return {
    ...key(input),
    conversationId: input.conversationId,
    requestFingerprint: input.requestFingerprint,
    protocol: input.protocol,
    ownerInstanceId: input.ownerInstanceId,
    processBootId: input.processBootId,
    generationEpoch: input.generationEpoch,
    segmentId: input.segmentId,
    ...(binding === undefined ? {} : { continuation: continuation(binding) }),
  };
}
function queryFence(input: GenerationAdmissionInput): FilterQuery<GenerationAdmissionRecord> {
  return { ...fence(input), continuation: input.continuation ?? { $exists: false } };
}
function dataSnapshot<T>(value: T): T {
  if (value === null || typeof value !== 'object') throw new Error();
  const prototype = Object.getPrototypeOf(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    (prototype !== null && prototype !== Object.prototype) ||
    Object.getOwnPropertySymbols(value).length > 0 ||
    Object.values(descriptors).some((descriptor) => !('value' in descriptor))
  )
    throw new Error();
  return Object.create(null, descriptors) as T;
}
function snapshotAdmission(input: GenerationAdmissionInput): Readonly<GenerationAdmissionInput> {
  const data = dataSnapshot(input);
  const copy = fence({
    ...data,
    ...(data.continuation === undefined ? {} : { continuation: dataSnapshot(data.continuation) }),
  });
  if (!valid(copy)) throw new Error();
  if (copy.continuation !== undefined) Object.freeze(copy.continuation);
  return Object.freeze(copy);
}
/** One detached, immutable server-owned admission snapshot shared by checkpoint consumers. */
export function snapshotGenerationCheckpointAdmission(
  input: GenerationAdmissionInput,
): Readonly<GenerationAdmissionInput> {
  try {
    const copy = snapshotAdmission(input);
    if (copy.continuation === undefined) throw new Error();
    return copy;
  } catch {
    throw new Error('Invalid generation checkpoint admission');
  }
}
function sameContinuation(
  left: GenerationCheckpointBinding | undefined,
  right: GenerationCheckpointBinding | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.version === right.version &&
    left.runId === right.runId &&
    left.threadId === right.threadId &&
    left.checkpointNamespace === right.checkpointNamespace &&
    left.graphFingerprint === right.graphFingerprint &&
    left.policyFingerprint === right.policyFingerprint &&
    left.mode === right.mode &&
    left.sourceBindingSha256 === right.sourceBindingSha256
  );
}
function plain(row: GenerationAdmissionRecord): GenerationAdmissionRecord {
  return {
    ...fence(row),
    state: row.state,
    active: row.active,
    createdAt: row.createdAt,
    checkpointWriteRevision: row.checkpointWriteRevision ?? 0,
    ...(row.recoveries?.length
      ? {
          recoveries: row.recoveries.map((previous) => ({
            ownerInstanceId: previous.ownerInstanceId,
            processBootId: previous.processBootId,
            segmentId: previous.segmentId,
            dispatchedAt: previous.dispatchedAt,
            recoveredAt: previous.recoveredAt,
            evidence: {
              checkpointWriteRevision: previous.evidence.checkpointWriteRevision,
              terminationEvidenceSha256: previous.evidence.terminationEvidenceSha256,
              effectsEvidenceSha256: previous.evidence.effectsEvidenceSha256,
            },
          })),
        }
      : {}),
    ...(row.predecessors?.length
      ? {
          predecessors: row.predecessors.map((previous) => ({
            ownerInstanceId: previous.ownerInstanceId,
            processBootId: previous.processBootId,
            segmentId: previous.segmentId,
            dispatchedAt: previous.dispatchedAt,
            settledAt: previous.settledAt,
            terminal: {
              outcome: previous.terminal.outcome,
              evidenceSha256: previous.terminal.evidenceSha256,
            },
          })),
        }
      : {}),
    ...(row.dispatchedAt ? { dispatchedAt: row.dispatchedAt } : {}),
    ...(row.settledAt ? { settledAt: row.settledAt } : {}),
    ...(row.terminal?.outcome
      ? { terminal: { outcome: row.terminal.outcome, evidenceSha256: row.terminal.evidenceSha256 } }
      : {}),
  };
}
function code(error: unknown): number | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'number'
    ? error.code
    : undefined;
}
function unknownWrite(error: unknown): boolean {
  return (
    errorLabel(error, 'UnknownTransactionCommitResult') ||
    (error instanceof Error &&
      (/^Mongo(Network|ServerSelection|OperationTimeout|WriteConcern)/.test(error.name) ||
        [50, 64, 91, 189, 262, 10107, 11600, 11602].includes(code(error) ?? -1)))
  );
}
function errorLabel(error: unknown, label: string): boolean {
  return (
    error instanceof Error &&
    'hasErrorLabel' in error &&
    typeof error.hasErrorLabel === 'function' &&
    error.hasErrorLabel(label) === true
  );
}
function storageFailure(error: unknown): GenerationAdmissionResult<never> {
  if (unknownWrite(error)) return failure('OUTCOME_UNKNOWN');
  throw new GenerationAdmissionStorageError();
}

/** Only an acknowledged winning CAS grants dispatch; reads and retries never do. */
export function createGenerationAdmissionMethods(
  mongoose: typeof import('mongoose'),
): GenerationAdmissionMethods {
  const Model = createGenerationAdmissionModel(mongoose);
  let indexes: Promise<void> | undefined;
  async function ensureGenerationAdmissionIndexes(): Promise<void> {
    indexes ??= Model.createIndexes()
      .then(() => undefined)
      .catch(() => {
        indexes = undefined;
        throw new GenerationAdmissionStorageError();
      });
    await indexes;
  }
  async function read(input: GenerationAdmissionKey): Promise<GenerationAdmissionRecord | null> {
    const row = await Model.findOne(key(input)).read('primary').readConcern('majority').lean();
    return row ? plain(row) : null;
  }
  async function getGenerationAdmission(input: GenerationAdmissionKey) {
    if (!validKey(input)) return failure('INVALID_INPUT');
    try {
      await ensureGenerationAdmissionIndexes();
      return { ok: true as const, value: await read(input) };
    } catch (error) {
      return storageFailure(error);
    }
  }
  async function acquireGenerationAdmission(input: GenerationAdmissionInput) {
    try {
      input = snapshotAdmission(input);
    } catch {
      return failure('INVALID_INPUT');
    }
    await ensureGenerationAdmissionIndexes();
    try {
      const [row] = await Model.create(
        [
          {
            ...input,
            checkpointWriteRevision: 0,
            state: 'admitted',
            active: true,
            createdAt: new Date().toISOString(),
          },
        ],
        { writeConcern },
      );
      return { ok: true as const, value: { acquired: true, record: plain(row) } };
    } catch (error) {
      if (code(error) !== 11000) return storageFailure(error);
      try {
        const row = await read(input);
        if (!row) return failure('CONVERSATION_ACTIVE');
        if (
          row.conversationId !== input.conversationId ||
          row.requestFingerprint !== input.requestFingerprint ||
          row.protocol !== input.protocol ||
          row.generationEpoch !== input.generationEpoch ||
          !sameContinuation(row.continuation, input.continuation)
        ) {
          return failure('REQUEST_CONFLICT');
        }
        return { ok: true as const, value: { acquired: false, record: row } };
      } catch (readError) {
        return storageFailure(readError);
      }
    }
  }
  async function dispatchGenerationAdmission(input: GenerationAdmissionInput) {
    try {
      input = snapshotAdmission(input);
    } catch {
      return failure('INVALID_INPUT');
    }
    await ensureGenerationAdmissionIndexes();
    try {
      const row = await Model.findOneAndUpdate(
        { ...queryFence(input), active: true, state: 'admitted' },
        { $set: { state: 'dispatching', dispatchedAt: new Date().toISOString() } },
        { new: true, writeConcern },
      ).lean();
      return row ? { ok: true as const, value: plain(row) } : failure('HELD');
    } catch (error) {
      return storageFailure(error);
    }
  }
  async function settleGenerationAdmission(
    input: GenerationAdmissionInput,
    terminal: GenerationAdmissionTerminal,
  ) {
    try {
      input = snapshotAdmission(input);
    } catch {
      return failure('INVALID_INPUT');
    }
    if (
      !terminal ||
      !['completed', 'failed', 'cancelled'].includes(terminal.outcome) ||
      typeof terminal.evidenceSha256 !== 'string' ||
      !sha256.test(terminal.evidenceSha256)
    ) {
      return failure('INVALID_INPUT');
    }
    terminal = { outcome: terminal.outcome, evidenceSha256: terminal.evidenceSha256 };
    await ensureGenerationAdmissionIndexes();
    try {
      const row = await Model.findOneAndUpdate(
        { ...queryFence(input), active: true, state: 'dispatching' },
        {
          $set: {
            state: 'settled',
            active: false,
            settledAt: new Date().toISOString(),
            terminal: { outcome: terminal.outcome, evidenceSha256: terminal.evidenceSha256 },
          },
        },
        { new: true, writeConcern },
      ).lean();
      return row ? { ok: true as const, value: plain(row) } : failure('HELD');
    } catch (error) {
      return storageFailure(error);
    }
  }
  async function acquireGenerationAdmissionSuccessor(
    predecessor: GenerationAdmissionInput,
    terminal: GenerationAdmissionTerminal,
    successor: GenerationAdmissionSuccessor,
  ) {
    try {
      predecessor = snapshotAdmission(predecessor);
    } catch {
      return failure('INVALID_INPUT');
    }
    if (
      !terminal ||
      !['completed', 'failed', 'cancelled'].includes(terminal.outcome) ||
      typeof terminal.evidenceSha256 !== 'string' ||
      !sha256.test(terminal.evidenceSha256) ||
      !successor ||
      ![successor.ownerInstanceId, successor.processBootId, successor.segmentId].every(text) ||
      successor.segmentId === predecessor.segmentId
    )
      return failure('INVALID_INPUT');
    terminal = { outcome: terminal.outcome, evidenceSha256: terminal.evidenceSha256 };
    successor = {
      ownerInstanceId: successor.ownerInstanceId,
      processBootId: successor.processBootId,
      segmentId: successor.segmentId,
    };
    await ensureGenerationAdmissionIndexes();
    try {
      const row = await Model.findOneAndUpdate(
        {
          ...queryFence(predecessor),
          state: 'settled',
          active: false,
          'terminal.outcome': terminal.outcome,
          'terminal.evidenceSha256': terminal.evidenceSha256,
          'predecessors.segmentId': { $ne: successor.segmentId },
          'recoveries.segmentId': { $ne: successor.segmentId },
        },
        [
          {
            $set: {
              predecessors: {
                $concatArrays: [
                  { $ifNull: ['$predecessors', []] },
                  [
                    {
                      ownerInstanceId: '$ownerInstanceId',
                      processBootId: '$processBootId',
                      segmentId: '$segmentId',
                      dispatchedAt: '$dispatchedAt',
                      settledAt: '$settledAt',
                      terminal: '$terminal',
                    },
                  ],
                ],
              },
              ownerInstanceId: { $literal: successor.ownerInstanceId },
              processBootId: { $literal: successor.processBootId },
              segmentId: { $literal: successor.segmentId },
              state: 'admitted',
              active: true,
              dispatchedAt: '$$REMOVE',
              settledAt: '$$REMOVE',
              terminal: '$$REMOVE',
            },
          },
        ],
        { new: true, writeConcern },
      ).lean();
      return row ? { ok: true as const, value: plain(row) } : failure('HELD');
    } catch (error) {
      if (code(error) === 11000) return failure('CONVERSATION_ACTIVE');
      return storageFailure(error);
    }
  }
  async function cancelUndispatchedGenerationAdmission(input: GenerationAdmissionInput) {
    try {
      input = snapshotAdmission(input);
    } catch {
      return failure('INVALID_INPUT');
    }
    await ensureGenerationAdmissionIndexes();
    try {
      const row = await Model.findOneAndUpdate(
        { ...queryFence(input), state: 'admitted', active: true },
        {
          $set: {
            state: 'settled',
            active: false,
            settledAt: new Date().toISOString(),
            terminal: { outcome: 'cancelled', evidenceSha256: input.requestFingerprint },
          },
        },
        { new: true, writeConcern },
      ).lean();
      return row ? { ok: true as const, value: plain(row) } : failure('HELD');
    } catch (error) {
      return storageFailure(error);
    }
  }
  async function recoverGenerationAdmission(
    predecessor: GenerationAdmissionInput,
    evidence: GenerationCheckpointRecoveryEvidence,
    successor: GenerationAdmissionSuccessor,
  ): Promise<GenerationAdmissionResult<GenerationAdmissionRecord>> {
    try {
      predecessor = snapshotGenerationCheckpointAdmission(predecessor);
      evidence = {
        checkpointWriteRevision: evidence.checkpointWriteRevision,
        terminationEvidenceSha256: evidence.terminationEvidenceSha256,
        effectsEvidenceSha256: evidence.effectsEvidenceSha256,
      };
      successor = {
        ownerInstanceId: successor.ownerInstanceId,
        processBootId: successor.processBootId,
        segmentId: successor.segmentId,
      };
    } catch {
      return failure('INVALID_INPUT');
    }
    if (
      !Number.isSafeInteger(evidence.checkpointWriteRevision) ||
      evidence.checkpointWriteRevision < 0 ||
      ![evidence.terminationEvidenceSha256, evidence.effectsEvidenceSha256].every(
        (value) => typeof value === 'string' && sha256.test(value),
      ) ||
      !Object.values(successor).every(text) ||
      successor.segmentId === predecessor.segmentId
    )
      return failure('INVALID_INPUT');
    await ensureGenerationAdmissionIndexes();
    try {
      const row = await Model.findOneAndUpdate(
        {
          ...queryFence(predecessor),
          active: true,
          state: 'dispatching',
          checkpointWriteRevision: evidence.checkpointWriteRevision,
          'predecessors.segmentId': { $ne: successor.segmentId },
          'recoveries.segmentId': { $ne: successor.segmentId },
          'recoveries.127': { $exists: false },
          dispatchedAt: { $type: 'string' },
        },
        [
          {
            $set: {
              recoveries: {
                $concatArrays: [
                  { $ifNull: ['$recoveries', []] },
                  [
                    {
                      ownerInstanceId: '$ownerInstanceId',
                      processBootId: '$processBootId',
                      segmentId: '$segmentId',
                      dispatchedAt: '$dispatchedAt',
                      recoveredAt: new Date().toISOString(),
                      evidence: { $literal: evidence },
                    },
                  ],
                ],
              },
              ownerInstanceId: { $literal: successor.ownerInstanceId },
              processBootId: { $literal: successor.processBootId },
              segmentId: { $literal: successor.segmentId },
              state: 'admitted',
              dispatchedAt: '$$REMOVE',
            },
          },
        ],
        { new: true, writeConcern },
      ).lean();
      return row ? { ok: true, value: plain(row) } : failure('HELD');
    } catch (error) {
      return storageFailure(error);
    }
  }
  async function writeGenerationCheckpoint<T>(
    input: GenerationAdmissionInput,
    write: (session: ClientSession) => Promise<T>,
  ): Promise<GenerationAdmissionResult<T>> {
    try {
      input = snapshotGenerationCheckpointAdmission(input);
    } catch {
      return failure('INVALID_INPUT');
    }
    if (typeof write !== 'function') return failure('INVALID_INPUT');
    await ensureGenerationAdmissionIndexes();
    for (let attempt = 0; attempt < 3; attempt++) {
      let session: ClientSession;
      try {
        session = await mongoose.startSession();
      } catch (error) {
        return storageFailure(error);
      }
      let committing = false;
      try {
        session.startTransaction({
          readConcern: { level: 'snapshot' },
          writeConcern,
          maxCommitTimeMS: 5000,
        });
        const row = await Model.findOneAndUpdate(
          {
            ...queryFence(input),
            active: true,
            state: 'dispatching',
            checkpointWriteRevision: { $gte: 0, $lt: Number.MAX_SAFE_INTEGER },
            $expr: { $eq: [{ $mod: ['$checkpointWriteRevision', 1] }, 0] },
          },
          { $inc: { checkpointWriteRevision: 1 } },
          { new: true, session, maxTimeMS: 5000 },
        ).lean();
        if (row === null) {
          await session.abortTransaction();
          return failure('HELD');
        }
        const value = await write(session);
        committing = true;
        await session.commitTransaction();
        return { ok: true, value };
      } catch (error) {
        if (session.inTransaction()) {
          try {
            await session.abortTransaction();
          } catch {
            /* Preserve the original uncertainty. */
          }
        }
        if (
          !committing &&
          !unknownWrite(error) &&
          code(error) === 112 &&
          errorLabel(error, 'TransientTransactionError')
        ) {
          if (attempt < 2) continue;
          return failure('HELD');
        }
        return storageFailure(error);
      } finally {
        await session.endSession();
      }
    }
    return failure('HELD');
  }
  async function findGenerationAdmissionByEpoch(input: {
    tenantId: string;
    principalId: string;
    conversationId: string;
    generationEpoch: number;
  }) {
    if (
      !input ||
      ![input.tenantId, input.principalId, input.conversationId].every(text) ||
      !Number.isSafeInteger(input.generationEpoch) ||
      input.generationEpoch < 0
    )
      return failure('INVALID_INPUT');
    try {
      const rows = await Model.find({
        tenantId: input.tenantId,
        principalId: input.principalId,
        conversationId: input.conversationId,
        generationEpoch: input.generationEpoch,
      })
        .read('primary')
        .readConcern('majority')
        .limit(2)
        .lean();
      if (rows.length > 1) return failure('HELD');
      return { ok: true as const, value: rows[0] ? plain(rows[0]) : null };
    } catch (error) {
      return storageFailure(error);
    }
  }
  async function countUnsettledGenerationAdmissions(ownerInstanceId: string) {
    if (!text(ownerInstanceId)) return failure('INVALID_INPUT');
    try {
      const value = await Model.countDocuments({ ownerInstanceId, active: true })
        .read('primary')
        .readConcern('majority');
      return { ok: true as const, value };
    } catch (error) {
      return storageFailure(error);
    }
  }
  return {
    recoverGenerationAdmission,
    writeGenerationCheckpoint,
    cancelUndispatchedGenerationAdmission,
    findGenerationAdmissionByEpoch,
    countUnsettledGenerationAdmissions,
    acquireGenerationAdmissionSuccessor,
    ensureGenerationAdmissionIndexes,
    getGenerationAdmission,
    acquireGenerationAdmission,
    dispatchGenerationAdmission,
    settleGenerationAdmission,
  };
}
