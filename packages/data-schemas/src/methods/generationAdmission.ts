import type {
  GenerationAdmissionKey,
  GenerationAdmissionSuccessor,
  GenerationAdmissionInput,
  GenerationAdmissionRecord,
  GenerationAdmissionMethods,
  GenerationAdmissionTerminal,
  GenerationAdmissionFailureCode,
  GenerationAdmissionResult,
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
    input.generationEpoch >= 0
  );
}
function fence(input: GenerationAdmissionInput): GenerationAdmissionInput {
  return {
    ...key(input),
    conversationId: input.conversationId,
    requestFingerprint: input.requestFingerprint,
    protocol: input.protocol,
    ownerInstanceId: input.ownerInstanceId,
    processBootId: input.processBootId,
    generationEpoch: input.generationEpoch,
    segmentId: input.segmentId,
  };
}
function plain(row: GenerationAdmissionRecord): GenerationAdmissionRecord {
  return {
    ...fence(row),
    state: row.state,
    active: row.active,
    createdAt: row.createdAt,
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
    error instanceof Error &&
    (/^Mongo(Network|ServerSelection|OperationTimeout|WriteConcern)/.test(error.name) ||
      [50, 64, 91, 189, 262, 10107, 11600, 11602].includes(code(error) ?? -1))
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
    if (!valid(input)) return failure('INVALID_INPUT');
    await ensureGenerationAdmissionIndexes();
    try {
      const [row] = await Model.create(
        [{ ...fence(input), state: 'admitted', active: true, createdAt: new Date().toISOString() }],
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
          row.protocol !== input.protocol
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
    if (!valid(input)) return failure('INVALID_INPUT');
    await ensureGenerationAdmissionIndexes();
    try {
      const row = await Model.findOneAndUpdate(
        { ...fence(input), active: true, state: 'admitted' },
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
    if (
      !valid(input) ||
      !terminal ||
      !['completed', 'failed', 'cancelled'].includes(terminal.outcome) ||
      typeof terminal.evidenceSha256 !== 'string' ||
      !sha256.test(terminal.evidenceSha256)
    ) {
      return failure('INVALID_INPUT');
    }
    await ensureGenerationAdmissionIndexes();
    try {
      const row = await Model.findOneAndUpdate(
        { ...fence(input), active: true, state: 'dispatching' },
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
    if (
      !valid(predecessor) ||
      !terminal ||
      !['completed', 'failed', 'cancelled'].includes(terminal.outcome) ||
      typeof terminal.evidenceSha256 !== 'string' ||
      !sha256.test(terminal.evidenceSha256) ||
      !successor ||
      ![successor.ownerInstanceId, successor.processBootId, successor.segmentId].every(text) ||
      successor.segmentId === predecessor.segmentId
    )
      return failure('INVALID_INPUT');
    await ensureGenerationAdmissionIndexes();
    try {
      const row = await Model.findOneAndUpdate(
        {
          ...fence(predecessor),
          state: 'settled',
          active: false,
          'terminal.outcome': terminal.outcome,
          'terminal.evidenceSha256': terminal.evidenceSha256,
          'predecessors.segmentId': { $ne: successor.segmentId },
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
    if (!valid(input)) return failure('INVALID_INPUT');
    await ensureGenerationAdmissionIndexes();
    try {
      const row = await Model.findOneAndUpdate(
        { ...fence(input), state: 'admitted', active: true },
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
