import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ManagedUploadSnapshot, ManagedUploadView } from 'librechat-data-provider';
import type { ExtendedFile } from '~/common';
import { ManagedUploadCard, ManagedUploadPanel } from './ManagedUploadPanel';
import { readUploadSnapshot, changeUpload } from './api';
import mockEnglish from '~/locales/en/translation.json';
import mockGerman from '~/locales/de/translation.json';
import { readManagedUploadSnapshot } from './live';

let mockLocale = 'en';
let mockEligible = true;
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
jest.mock('librechat-data-provider', () => ({ getTokenHeader: () => 'Bearer verified' }));
jest.mock('recoil', () => ({ useRecoilValue: () => ({ id: 'user', tenantId: 'tenant' }) }));
jest.mock('~/store', () => ({ __esModule: true, default: { user: {} } }));
jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({
    data: { managedUploads: { enabled: true, eligible: mockEligible } },
  }),
}));
jest.mock('~/hooks/useLocalize', () => ({
  __esModule: true,
  default: () => (key: string) => {
    const translations: Record<string, string> = mockLocale === 'de' ? mockGerman : mockEnglish;
    return translations[key] ?? key;
  },
}));
jest.mock('./api', () => ({
  uploadsUrl: '/api/uploads',
  readUploadSnapshot: jest.fn(),
  changeUpload: jest.fn().mockResolvedValue({}),
  abortManagedTransfer: jest.fn(),
}));
jest.mock('./transfer', () => ({ cancelManagedSelection: jest.fn() }));

const operation: ManagedUploadView = {
  version: 1,
  id: 'admitted',
  revision: 1,
  scope: { kind: 'personal' },
  filename: 'retained.txt',
  mediaType: 'text/plain',
  declaredBytes: 4,
  state: 'failed',
  createdAt: '2026-10-14T00:00:00Z',
  acceptedAt: '2026-10-14T00:00:01Z',
  expiresAt: '2026-11-11T00:00:01Z',
  cleanupPending: true,
  canUseInComposer: false,
  canRetryProcessing: true,
};
const snapshot: ManagedUploadSnapshot = {
  version: 1,
  operations: [operation],
  admissionsPaused: false,
  throttled: false,
  waitingReason: null,
  usage: {
    limitBytes: 300 * 1_048_576,
    usedBytes: 4,
    reservedBytes: 0,
    availableBytes: 300 * 1_048_576 - 4,
    retainedBytes: 4,
    nextReleaseAt: null,
    nextReleaseBytes: 0,
  },
};
const file: ExtendedFile = {
  file_id: operation.id,
  filename: operation.filename,
  size: 4,
  progress: 1,
  managedUpload: { phase: 'failed', operation },
};

/** Exercises the real hook/live owner and visible actions with bounded transport fixtures. */
describe('managed upload admission UI', () => {
  let client: QueryClient;
  const read = readUploadSnapshot as jest.Mock;
  const key = ['managed-uploads', 'tenant', 'user'];
  beforeEach(() => {
    mockLocale = 'en';
    mockEligible = true;
    mockStreams.length = 0;
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    read.mockReset().mockResolvedValue(snapshot);
    client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
      logger: { log: console.log, warn: console.warn, error: jest.fn() },
    });
  });
  afterEach(() => client.clear());
  const view = (selected = file) =>
    render(
      <QueryClientProvider client={client}>
        <ManagedUploadPanel />
        <ManagedUploadCard file={selected} onRemove={jest.fn()} />
      </QueryClientProvider>,
    );
  const status = (value: boolean | null) =>
    act(() => {
      mockStreams.at(-1)!.listeners.status?.({
        data: JSON.stringify({ admissionsPaused: value }),
      });
    });

  it.each(['en', 'de'])(
    'updates an open %s panel from status without an HTTP fetch',
    async (locale) => {
      mockLocale = locale;
      const rendered = view();
      await waitFor(() => expect(mockStreams).toHaveLength(1));
      const calls = read.mock.calls.length;
      status(true);
      expect(client.getQueryData<ManagedUploadSnapshot>(key)?.admissionsPaused).toBe(true);
      expect(
        await screen.findByText(
          locale === 'de'
            ? 'Neue Uploads sind vorübergehend pausiert. Bereits angenommene Uploads können weiterlaufen.'
            : 'New uploads are temporarily paused. Uploads already admitted can continue.',
        ),
      ).toBeInTheDocument();
      expect(screen.getByText('retained.txt')).toBeInTheDocument();
      status(false);
      await waitFor(() =>
        expect(
          screen.queryByText(/^(New uploads are temporarily paused|Neue Uploads sind)/),
        ).toBeNull(),
      );
      expect(read).toHaveBeenCalledTimes(calls);
      rendered.unmount();
    },
  );

  it('keeps the prior files and quota error visible when a newer live status restores readiness', async () => {
    const rendered = view();
    await waitFor(() => expect(mockStreams).toHaveLength(1));
    read.mockRejectedValueOnce(new Error('offline'));
    await act(async () => {
      await expect(
        client.fetchQuery(key, ({ signal }) => readManagedUploadSnapshot(client, key, signal), {
          staleTime: 0,
          retry: false,
        }),
      ).rejects.toThrow('offline');
    });
    expect(client.getQueryData<ManagedUploadSnapshot>(key)?.admissionsPaused).toBeNull();
    expect(await screen.findByText(/Upload status is currently unavailable/)).toBeInTheDocument();
    expect(
      await screen.findByText(/The file and quota display could not be refreshed/),
    ).toBeInTheDocument();
    expect(screen.getByText('retained.txt')).toBeInTheDocument();
    status(false);
    await waitFor(() =>
      expect(screen.queryByText(/Upload status is currently unavailable/)).toBeNull(),
    );
    expect(
      screen.getByText(/The file and quota display could not be refreshed/),
    ).toBeInTheDocument();
    expect(client.getQueryData<ManagedUploadSnapshot>(key)?.operations).toEqual([operation]);
    rendered.unmount();
  });

  it.each([true, null])(
    'keeps admitted processing retry and deletion enabled when paused=%s',
    async (paused) => {
      const rendered = view();
      await waitFor(() => expect(mockStreams).toHaveLength(1));
      status(paused);
      expect(
        await screen.findByText(
          paused ? /New uploads are temporarily paused/ : /Upload status is currently unavailable/,
        ),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Retry processing' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Delete file' })).toBeEnabled();
      fireEvent.click(screen.getByRole('button', { name: 'Retry processing' }));
      await waitFor(() => expect(changeUpload).toHaveBeenCalledWith('admitted', 'retry'));
      rendered.unmount();
    },
  );

  it('keeps cancellation enabled for an admitted transfer during a pause', async () => {
    const transferring = {
      ...operation,
      state: 'transferring' as const,
      canRetryProcessing: false,
    };
    read.mockResolvedValue({ ...snapshot, operations: [transferring] });
    const rendered = view({
      ...file,
      managedUpload: { phase: 'transferring', operation: transferring },
    });
    await waitFor(() => expect(mockStreams).toHaveLength(1));
    status(true);
    expect(await screen.findByText(/New uploads are temporarily paused/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(changeUpload).toHaveBeenCalledWith('admitted', 'cancel'));
    rendered.unmount();
  });

  it('localizes a server admission race rather than claiming quota or transfer failure', async () => {
    const rendered = view({
      ...file,
      managedUpload: { phase: 'failed', error: 'admission_paused' },
    });
    expect(screen.getByRole('alert')).toHaveTextContent('New uploads are temporarily paused');
    rendered.unmount();
  });

  it('keeps the guest sign-in explanation without opening an upload stream', async () => {
    mockEligible = false;
    const rendered = view();
    expect(screen.getByText(/Chats remain available without signing in/)).toBeInTheDocument();
    expect(read).not.toHaveBeenCalled();
    expect(mockStreams).toHaveLength(0);
    rendered.unmount();
  });
});
