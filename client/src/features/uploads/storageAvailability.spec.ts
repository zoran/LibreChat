/** storageAvailability proves safe public status, lease expiry and independent admission causes. */
import { v4 } from 'uuid';
import { QueryClient } from '@tanstack/react-query';
import { readManagedUploadFeatureCapability } from 'librechat-data-provider';
import {
  acquireUploadLive,
  readManagedUploadSnapshot,
  getUploadAdmission,
  getUploadStorageAvailability,
} from './live';
import { uploadAdmissionError } from './admission';
import { readUploadSnapshot } from './api';

jest.mock('./api', () => ({ uploadsUrl: '/api/uploads', readUploadSnapshot: jest.fn() }));
jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  getTokenHeader: () => 'Bearer inert-fixture',
}));
const mockStreams: { listeners: Record<string, (event?: unknown) => void> }[] = [];
jest.mock('sse.js', () => ({
  SSE: class {
    listeners: Record<string, (event?: unknown) => void> = {};
    constructor() {
      mockStreams.push(this);
    }

    addEventListener(name: string, listener: (event?: unknown) => void) {
      this.listeners[name] = listener;
    }

    close() {}
    stream() {}
  },
}));
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
const ready = { available: true, reason: null };
const missing = { available: false, reason: 'storage-unavailable' };
const read = readUploadSnapshot as jest.Mock;

describe('storage admission at the actual live owner', () => {
  let client: QueryClient;
  const key = ['managed-uploads', 'tenant', 'storage-user'];
  beforeEach(() => {
    jest.useFakeTimers();
    mockStreams.length = 0;
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    read.mockResolvedValue({ admissionsPaused: false, operations: [], usage: {} });
  });
  afterEach(() => {
    client.clear();
    jest.useRealTimers();
  });
  const status = (storageAvailability: unknown, admissionsPaused = false) =>
    mockStreams
      .at(-1)!
      .listeners.status({ data: JSON.stringify({ admissionsPaused, storageAvailability }) });
  it('closes NAS before its first status and preserves genuine two-flag legacy input', async () => {
    expect(readManagedUploadFeatureCapability({ enabled: true, eligible: true })).toEqual({
      enabled: true,
      eligible: true,
      storageAvailabilityRequired: false,
    });
    expect(
      readManagedUploadFeatureCapability({
        enabled: true,
        eligible: true,
        storageAvailabilityRequired: null,
      }),
    ).toBeNull();
    expect(getUploadStorageAvailability(client, key, true)).toEqual(missing);
    const stop = acquireUploadLive(client, key, true);
    await flush();
    expect(getUploadAdmission(client, key)).toBeNull();
    stop();
  });
  it('recovers storage without clearing manual pause or quota restrictions', async () => {
    const stop = acquireUploadLive(client, key, true);
    await flush();
    status(missing);
    expect(getUploadAdmission(client, key)).toBeNull();
    status(ready, true);
    expect(getUploadAdmission(client, key)).toBe(true);
    expect(
      uploadAdmissionError({
        eligible: true,
        admissionsPaused: true,
        storageAvailability: { available: true, reason: null },
      }),
    ).toBe('com_upload_admission_paused');
    expect(
      uploadAdmissionError({
        eligible: true,
        admissionsPaused: false,
        storageAvailability: { available: true, reason: null },
        availableBytes: 0,
      }),
    ).toBe('com_upload_quota_exceeded');
    status(ready);
    expect(getUploadAdmission(client, key)).toBe(false);
    stop();
  });
  it('never downgrades an observed NAS identity after missing/reset/invalid frames or remount', async () => {
    const stop = acquireUploadLive(client, key);
    await flush();
    status(ready);
    expect(getUploadAdmission(client, key)).toBe(false);
    mockStreams.at(-1)!.listeners.status({ data: JSON.stringify({ admissionsPaused: false }) });
    expect(getUploadStorageAvailability(client, key)).toEqual(missing);
    const syntheticPrivateValue = v4();
    status({ available: true, reason: null, secret: syntheticPrivateValue });
    expect(getUploadAdmission(client, key)).toBeNull();
    expect(JSON.stringify(client.getQueryData(key) ?? null)).not.toContain(syntheticPrivateValue);
    stop();
    const remounted = acquireUploadLive(client, key);
    await flush();
    expect(getUploadAdmission(client, key)).toBeNull();
    remounted();
  });
  it('expires a positive lease and closes hidden tabs without clearing retained data', async () => {
    const stop = acquireUploadLive(client, key, true);
    await flush();
    status(ready);
    jest.advanceTimersByTime(20_001);
    expect(getUploadAdmission(client, key)).toBeNull();
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(getUploadStorageAvailability(client, key)?.available).toBe(false);
    stop();
  });
  it('keeps legacy snapshots field-absent and rejects stale selection independently', async () => {
    const data = await readManagedUploadSnapshot(client, key);
    expect(data).not.toHaveProperty('storageAvailability');
    expect(getUploadAdmission(client, key)).toBe(false);
    expect(
      uploadAdmissionError({
        eligible: true,
        admissionsPaused: false,
        storageAvailability: { available: false, reason: 'storage-stale' },
      }),
    ).toBe('com_upload_storage_stale');
  });
});
