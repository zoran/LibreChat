/** Initial source preparation shares the native admission collection and its active-owner indexes. */
import type { Model } from 'mongoose';
import type {
  GenerationAdmissionInput,
  GenerationAdmissionRecord,
  GenerationAdmissionStorageRecord,
  GenerationAdmissionResult,
  GenerationPreparationInput,
  GenerationPreparationRecord,
  GenerationCheckpointBinding,
} from '~/types/generationAdmission';

const writeConcern = { w: 'majority' as const, j: true };
const failed = (code: 'INVALID_INPUT' | 'HELD'): GenerationAdmissionResult<never> => ({
  ok: false,
  error: { code },
});

/** Snapshot server identity before an await; accessors and implicit prototype fields grant nothing. */
function snapshot(input: GenerationPreparationInput): Readonly<GenerationPreparationInput> {
  const fields = [
    'tenantId',
    'principalId',
    'clientRequestId',
    'conversationId',
    'requestFingerprint',
    'protocol',
    'ownerInstanceId',
    'processBootId',
    'preparationAttemptId',
  ] as const;
  if (!input || ![null, Object.prototype].includes(Object.getPrototypeOf(input))) throw new Error();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const copy = {} as GenerationPreparationInput;
  for (const field of fields) {
    const descriptor = descriptors[field];
    if (
      !descriptor ||
      !('value' in descriptor) ||
      typeof descriptor.value !== 'string' ||
      !descriptor.value.length ||
      descriptor.value.length > 256
    )
      throw new Error();
    copy[field] = descriptor.value;
  }
  if (!/^[a-f0-9]{64}$/.test(copy.requestFingerprint)) throw new Error();
  return Object.freeze(copy);
}

function plain(row: GenerationPreparationRecord): GenerationPreparationRecord {
  return {
    ...snapshot(row),
    state: row.state,
    active: true,
    createdAt: row.createdAt,
    ...(row.continuation === undefined ? {} : { continuation: row.continuation }),
  };
}

interface PreparationMethods {
  beginGenerationPreparation(
    input: GenerationPreparationInput,
  ): Promise<GenerationAdmissionResult<GenerationPreparationRecord>>;
  completeGenerationPreparation(
    input: GenerationPreparationInput,
    binding: GenerationCheckpointBinding,
  ): Promise<GenerationAdmissionResult<GenerationPreparationRecord>>;
  acquirePreparedGeneration(
    input: GenerationAdmissionInput,
    preparation: GenerationPreparationInput,
  ): Promise<GenerationAdmissionResult<GenerationAdmissionRecord>>;
}

export function createGenerationPreparationMethods(deps: {
  model: Model<GenerationAdmissionStorageRecord>;
  ensureIndexes(): Promise<void>;
  snapshotBinding(input: GenerationCheckpointBinding): Readonly<GenerationCheckpointBinding>;
  storageFailure(error: unknown): GenerationAdmissionResult<never>;
}): PreparationMethods {
  async function beginGenerationPreparation(
    input: GenerationPreparationInput,
  ): Promise<GenerationAdmissionResult<GenerationPreparationRecord>> {
    try {
      input = snapshot(input);
    } catch {
      return failed('INVALID_INPUT');
    }
    await deps.ensureIndexes();
    try {
      const [row] = await deps.model.create(
        [{ ...input, state: 'preparing', active: true, createdAt: new Date().toISOString() }],
        { writeConcern },
      );
      return { ok: true, value: plain(row.toObject() as GenerationPreparationRecord) };
    } catch (error) {
      if ((error as { code?: number })?.code === 11000) return failed('HELD');
      return deps.storageFailure(error);
    }
  }
  async function completeGenerationPreparation(
    input: GenerationPreparationInput,
    binding: GenerationCheckpointBinding,
  ): Promise<GenerationAdmissionResult<GenerationPreparationRecord>> {
    try {
      input = snapshot(input);
      binding = deps.snapshotBinding(binding);
      if (binding.threadId !== input.conversationId || binding.sourceBindingSha256 === undefined)
        return failed('INVALID_INPUT');
    } catch {
      return failed('INVALID_INPUT');
    }
    await deps.ensureIndexes();
    try {
      // Only this absent-field CAS may initialize the immutable continuation. Model middleware
      // remains active; every admitted record is excluded by the preparation-state fence.
      const row = await deps.model
        .findOneAndUpdate(
          {
            ...input,
            state: 'preparing',
            active: true,
            continuation: { $exists: false },
            generationEpoch: { $exists: false },
            segmentId: { $exists: false },
          },
          { $set: { state: 'prepared', continuation: binding } },
          { new: true, writeConcern, overwriteImmutable: true },
        )
        .lean();
      return row
        ? {
            ok: true,
            value: plain({
              ...input,
              state: 'prepared',
              active: true,
              createdAt: String(row.createdAt),
              continuation: binding,
            }),
          }
        : failed('HELD');
    } catch (error) {
      return deps.storageFailure(error);
    }
  }
  async function acquirePreparedGeneration(
    input: GenerationAdmissionInput,
    preparation: GenerationPreparationInput,
  ): Promise<GenerationAdmissionResult<GenerationAdmissionRecord>> {
    try {
      preparation = snapshot(preparation);
      if (
        !input.continuation ||
        Object.entries(preparation).some(
          ([field, value]) =>
            field !== 'preparationAttemptId' &&
            input[field as keyof GenerationAdmissionInput] !== value,
        )
      )
        return failed('INVALID_INPUT');
    } catch {
      return failed('INVALID_INPUT');
    }
    await deps.ensureIndexes();
    try {
      // The actual job supplies epoch/segment exactly once; no placeholder generation is stored.
      const row = await deps.model
        .findOneAndUpdate(
          {
            ...preparation,
            state: 'prepared',
            active: true,
            continuation: input.continuation,
            generationEpoch: { $exists: false },
            segmentId: { $exists: false },
          },
          {
            $set: {
              state: 'admitted',
              generationEpoch: input.generationEpoch,
              segmentId: input.segmentId,
              checkpointWriteRevision: 0,
            },
          },
          { new: true, writeConcern, overwriteImmutable: true },
        )
        .lean();
      return row
        ? {
            ok: true,
            value: {
              ...input,
              state: 'admitted',
              active: true,
              createdAt: String(row.createdAt),
              checkpointWriteRevision: 0,
            },
          }
        : failed('HELD');
    } catch (error) {
      return deps.storageFailure(error);
    }
  }
  return { beginGenerationPreparation, completeGenerationPreparation, acquirePreparedGeneration };
}
