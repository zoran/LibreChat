/** Private operational pause policy on the existing upload Counter and transaction authority. */
import type { UploadAdmissionCommand, UploadAdmissionPolicy } from 'librechat-data-provider';
import type {
  CounterRow,
  GlobalState,
  StoredUploadAdmissionPolicy,
  UploadStore,
} from './uploadManagementStore';
import { reject, uploadDigest } from './uploadManagementStore';

export type UploadAdmissionMethods = {
  getAdmissionPolicy(): Promise<UploadAdmissionPolicy>;
  setAdmissionPolicy(command: UploadAdmissionCommand): Promise<UploadAdmissionPolicy>;
};

/** Legacy absence is open; malformed present policy is never interpreted as permission. */
export function readUploadAdmission(source: { admission?: unknown }): StoredUploadAdmissionPolicy {
  if (!Object.prototype.hasOwnProperty.call(source, 'admission'))
    return { paused: false, revision: 0 };
  const value = source.admission;
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject('unavailable');
  const { paused, revision, lastRequestSha256 } = value as Record<string, unknown>;
  if (
    Object.keys(value).some((key) => !['paused', 'revision', 'lastRequestSha256'].includes(key)) ||
    typeof paused !== 'boolean' ||
    typeof revision !== 'number' ||
    !Number.isSafeInteger(revision) ||
    revision < 0
  )
    reject('unavailable');
  if (revision === 0) {
    if (paused || Object.prototype.hasOwnProperty.call(value, 'lastRequestSha256'))
      reject('unavailable');
    return { paused, revision };
  }
  if (typeof lastRequestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(lastRequestSha256))
    reject('unavailable');
  return { paused, revision, lastRequestSha256 };
}

const validStoreId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(value);

/** Operator-only methods; status is read-only and commands never initialize an authority. */
export function createUploadAdmissionMethods(store: UploadStore): UploadAdmissionMethods {
  return {
    async getAdmissionPolicy() {
      const row = await store.Counter.findById('global').lean<CounterRow>();
      const global = row?.value as GlobalState | undefined;
      if (!global || !validStoreId(global.storeId)) reject('unavailable');
      const policy = readUploadAdmission(global);
      return { storeId: global.storeId, revision: policy.revision, paused: policy.paused };
    },
    async setAdmissionPolicy(input) {
      const enteredAt = Date.now();
      const fields = ['storeId', 'expectedRevision', 'paused', 'originalDeadline'];
      if (
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.keys(input).length !== fields.length ||
        Object.keys(input).some((key) => !fields.includes(key))
      )
        reject('invalid_request');
      // Capture the complete request before the first await, including every digest input.
      const { storeId, expectedRevision, paused, originalDeadline } = input;
      if (
        !validStoreId(storeId) ||
        !Number.isSafeInteger(expectedRevision) ||
        expectedRevision < 0 ||
        expectedRevision >= Number.MAX_SAFE_INTEGER ||
        typeof paused !== 'boolean' ||
        typeof originalDeadline !== 'string' ||
        originalDeadline.length > 32
      )
        reject('invalid_request');
      const deadline = Date.parse(originalDeadline);
      if (!Number.isSafeInteger(deadline) || new Date(deadline).toISOString() !== originalDeadline)
        reject('invalid_request');
      const digest = uploadDigest([
        'upload-admission/v1',
        storeId,
        expectedRevision,
        paused,
        originalDeadline,
      ]);
      return store.transaction(async (_session, global) => {
        if (
          global.storeId !== storeId ||
          global.enabled !== true ||
          global.reconciled !== true ||
          global.migration ||
          global.migrationEpoch
        )
          reject('not_ready');
        const policy = readUploadAdmission(global);
        const revision = expectedRevision + 1;
        if (
          policy.revision === revision &&
          policy.paused === paused &&
          policy.lastRequestSha256 === digest
        )
          return { storeId, revision, paused };
        // Re-evaluate real time after every transaction retry. In-flight commit outcomes may be unknown.
        if (
          Date.now() >= deadline ||
          deadline > enteredAt + 300_000 ||
          policy.revision !== expectedRevision
        )
          reject('not_ready');
        global.admission = { paused, revision, lastRequestSha256: digest };
        return { storeId, revision, paused };
      });
    },
  };
}
