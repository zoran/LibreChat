/** uploadStorageBatch exercises the shared picker/drop/paste batch against real live admission. */
import { QueryClient } from '@tanstack/react-query';
import {
  acquireUploadLive,
  getUploadAdmission,
  getUploadStorageAvailability,
} from '~/features/uploads/live';
import { readUploadSnapshot, reserveUpload, sendUploadBody } from '~/features/uploads/api';
import { processUploadBatch } from '../processUploadBatch';

jest.mock('~/features/uploads/api', () => ({
  uploadsUrl: '/api/uploads',
  readUploadSnapshot: jest.fn(),
  reserveUpload: jest.fn(),
  sendUploadBody: jest.fn(),
  changeUpload: jest.fn(),
  UploadRequestError: class extends Error {},
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
jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  getTokenHeader: () => 'Bearer inert-fixture',
}));
// Legacy conversion/validation is exercised by the whole retained useFileHandling suite.
jest.mock('~/utils', () => ({
  validateFiles: jest.fn(() => {
    throw new Error('Unexpected legacy branch');
  }),
  cachePreview: jest.fn(),
  partitionUploads: jest.fn(),
  validateFileSizes: jest.fn(),
  validateFileLimit: jest.fn(),
  removePreviewEntry: jest.fn(),
  validateFileDuplicates: jest.fn(),
}));
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

describe('every source shares current storage admission after queue waits', () => {
  let client: QueryClient;
  let stop: () => void;
  const key = ['managed-uploads', 'tenant', 'batch-user'];
  let context: Parameters<typeof processUploadBatch>[0];
  beforeEach(async () => {
    mockStreams.length = 0;
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    (readUploadSnapshot as jest.Mock).mockResolvedValue({
      admissionsPaused: false,
      operations: [],
      usage: {},
    });
    stop = acquireUploadLive(client, key, true);
    await flush();
    context = {
      abortControllerRef: { current: null },
      managedEndingRef: { current: false },
      managedEpochRef: { current: 0 },
      managedIdentityRef: { current: 'same-user' },
      managedUploads: {
        enabled: true,
        eligible: true,
        sessionKey: 'same-user',
        getAdmissionsPaused: () => getUploadAdmission(client, key),
        refresh: jest.fn().mockResolvedValue(undefined),
        waitForReady: jest
          .fn()
          .mockResolvedValue({ attachment: { file_id: 'real-fixture-file', bytes: 127 } }),
        storageAvailability: getUploadStorageAvailability(client, key, true),
      },
      setError: jest.fn(),
      setFilesLoading: jest.fn(),
      isConversationUpload: true,
      addFile: jest.fn(),
      updateFileById: jest.fn(),
      filesRef: { current: new Map([['retained', {}]]) },
    } as unknown as Parameters<typeof processUploadBatch>[0];
    (reserveUpload as jest.Mock).mockResolvedValue({ id: 'fixture-reservation' });
    (sendUploadBody as jest.Mock).mockResolvedValue({
      id: 'fixture-reservation',
      state: 'processing',
    });
  });
  afterEach(() => {
    stop();
    client.clear();
  });
  const selected = () => new File(['x'.repeat(127)], 'catalog.txt', { type: 'text/plain' });
  const status = (available: boolean, admissionsPaused = false) =>
    mockStreams.at(-1)!.listeners.status({
      data: JSON.stringify({
        admissionsPaused,
        storageAvailability: available
          ? { available: true, reason: null }
          : { available: false, reason: 'storage-unavailable' },
      }),
    });

  it.each(['picker', 'drop', 'paste replacement'])(
    'blocks %s before state, reservation or body mutation',
    async () => {
      const old = context.filesRef.current;
      expect(
        await processUploadBatch(context, [selected()], undefined, { replacesFileId: 'retained' }),
      ).toBe(false);
      expect(context.addFile).not.toHaveBeenCalled();
      expect(reserveUpload).not.toHaveBeenCalled();
      expect(sendUploadBody).not.toHaveBeenCalled();
      expect(context.filesRef.current).toBe(old);
    },
  );
  it('reenables the same batch after real status recovery but retains a manual pause', async () => {
    status(true, true);
    expect(await processUploadBatch(context, [selected()])).toBe(false);
    expect(reserveUpload).not.toHaveBeenCalled();
    status(true);
    expect(await processUploadBatch(context, [selected()])).toBe(true);
    expect(reserveUpload).toHaveBeenCalledWith(
      expect.objectContaining({ declaredBytes: 127, scope: { kind: 'personal' } }),
      expect.any(AbortSignal),
    );
    expect(sendUploadBody).toHaveBeenCalledTimes(1);
    expect(context.updateFileById).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ progress: 1 }),
    );
  });
});
