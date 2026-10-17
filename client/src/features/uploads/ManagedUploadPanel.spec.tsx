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
let mockUser: { id: string; tenantId?: string; provider: string };
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
jest.mock('recoil', () => ({ useRecoilValue: () => mockUser }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ i18n: { resolvedLanguage: mockLocale, language: mockLocale } }),
}));
jest.mock('~/store', () => ({ __esModule: true, default: { user: {} } }));
jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({
    data: { managedUploads: { enabled: true, eligible: mockEligible } },
  }),
}));
jest.mock('~/hooks/useLocalize', () => ({
  __esModule: true,
  default: () => (key: string, options?: Record<string, unknown>) => {
    const translations: Record<string, string> = mockLocale === 'de' ? mockGerman : mockEnglish;
    return (translations[key] ?? key).replace(/\{\{(\d+)\}\}/g, (match, index) =>
      options?.[index] === undefined ? match : String(options[index]),
    );
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
    mockUser = { id: 'user', tenantId: 'tenant', provider: 'email_code' };
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
    'shows the %s classification warning before selection outside closed details',
    (locale) => {
      mockLocale = locale;
      read.mockResolvedValue({ ...snapshot, operations: [] });
      const rendered = render(
        <QueryClientProvider client={client}>
          <ManagedUploadPanel />
        </QueryClientProvider>,
      );
      const warning = screen.getByText(
        locale === 'de'
          ? 'Lade keine Dokumente hoch, die als VS-NfD oder höher eingestuft sind. Nutze dafür ausschließlich zugelassene Systeme.'
          : 'Do not upload documents classified as VS-NfD or higher. Use only approved systems for these documents.',
      );
      expect(warning).toBeVisible();
      expect(warning.closest('details')).toBeNull();
      expect(rendered.container.querySelector('details')).not.toHaveAttribute('open');
      expect(screen.queryByRole('alert')).toBeNull();
      rendered.unmount();
    },
  );

  it.each(
    ['en', 'de'].flatMap((locale) =>
      (['security_rejected', 'security_uninspectable'] as const).flatMap((error) =>
        (['local', 'snapshot'] as const).map((source) => ({ locale, error, source })),
      ),
    ),
  )(
    'explains $source $error in $locale without a retry or deletion promise',
    async ({ locale, error, source }) => {
      mockLocale = locale;
      const stale = {
        ...operation,
        acceptedAt: undefined,
        expiresAt: undefined,
        // A stale capability bit must not offer a way around a security failure.
        canRetryProcessing: true,
      };
      read.mockResolvedValue({
        ...snapshot,
        operations: [{ ...stale, error: source === 'snapshot' ? error : undefined }],
      });
      const rendered = view({
        ...file,
        managedUpload: {
          phase: 'failed',
          operation: stale,
          error: source === 'local' ? error : undefined,
        },
      });
      await waitFor(() => expect(mockStreams).toHaveLength(1));
      const alert = await screen.findByRole('alert');
      const reasons =
        locale === 'de'
          ? {
              security_rejected: /Kennzeichnung als VS-NfD oder höher/,
              security_uninspectable: /nicht sicher geprüft werden/,
            }
          : {
              security_rejected: /marking of VS-NfD or higher/,
              security_uninspectable: /could not be safely inspected/,
            };
      expect(alert).toHaveTextContent(reasons[error]);
      expect(alert).toHaveTextContent(
        locale === 'de' ? /nicht in Cortex übernommen/ : /not accepted into Cortex/,
      );
      expect(alert).not.toHaveTextContent(
        /security_rejected|security_uninspectable|scanner|sha256|classification_marking/i,
      );
      expect(alert).not.toHaveTextContent(/gelöscht|entfernt|deleted|removed/i);
      const translations = locale === 'de' ? mockGerman : mockEnglish;
      expect(screen.getByText(translations.com_upload_cleanup_pending)).toBeInTheDocument();
      expect(screen.queryByText(translations.com_upload_retry_from_start)).toBeNull();
      expect(
        screen.queryByRole('button', { name: translations.com_upload_retry_processing }),
      ).toBeNull();
      expect(changeUpload).not.toHaveBeenCalled();
      rendered.unmount();
    },
  );

  it('keeps a local safety failure visible over a generic stale server error', async () => {
    read.mockResolvedValue({ ...snapshot, operations: [{ ...operation, error: 'unavailable' }] });
    const rendered = view({
      ...file,
      managedUpload: { phase: 'failed', operation, error: 'security_rejected' },
    });
    await waitFor(() => expect(mockStreams).toHaveLength(1));
    expect(screen.getByRole('alert')).toHaveTextContent(/marking of VS-NfD or higher/);
    expect(screen.queryByRole('button', { name: 'Retry processing' })).toBeNull();
    rendered.unmount();
  });

  it('does not label rejected content deleted when its cleanup remains unconfirmed', async () => {
    mockLocale = 'de';
    read.mockResolvedValue({
      ...snapshot,
      operations: [
        { ...operation, state: 'deleted', error: 'security_rejected', cleanupPending: true },
      ],
    });
    const rendered = view();
    expect(await screen.findByRole('alert')).toHaveTextContent(/nicht in Cortex übernommen/);
    expect(screen.queryByText('Gelöscht')).toBeNull();
    expect(
      screen.getByText('Bereinigung steht noch aus. Der Speicher ist noch reserviert.'),
    ).toBeInTheDocument();
    rendered.unmount();
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
    mockUser = { id: 'guest-user', provider: 'browser' };
    const rendered = view();
    expect(screen.getByText(/Chats remain available without signing in/)).toBeInTheDocument();
    expect(read).not.toHaveBeenCalled();
    expect(mockStreams).toHaveLength(0);
    rendered.unmount();
  });

  it.each(['en', 'de'])('explains the eligible guest account allowance in %s', async (locale) => {
    mockLocale = locale;
    mockUser = { id: 'guest-user', provider: 'browser' };
    const rendered = view();
    await waitFor(() => expect(mockStreams).toHaveLength(1));
    expect(
      screen.getByText(
        locale === 'de'
          ? 'Gastkonto: 30 MiB je Datei · 300 MiB in 30 Tagen'
          : 'Guest account: 30 MiB per file · 300 MiB in 30 days',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        locale === 'de'
          ? /Das Kontingent gilt für dieses Gastkonto/
          : /This allowance applies to this guest account/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(locale === 'de' ? /kannst du den Zugriff verlieren/ : /you may lose access/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        locale === 'de'
          ? mockGerman.com_upload_rolling_explained
          : mockEnglish.com_upload_rolling_explained,
      ),
    ).toBeNull();
    expect(client.getQueryData(['managed-uploads', '', 'guest-user'])).toMatchObject({
      usage: snapshot.usage,
    });
    expect(
      screen.getByRole('button', {
        name: locale === 'de' ? 'Verarbeitung wiederholen' : 'Retry processing',
      }),
    ).toBeEnabled();
    rendered.unmount();
  });

  it('keeps the verified account explanation for eligible email users', async () => {
    const rendered = view();
    expect(await screen.findByText(mockEnglish.com_upload_rolling_explained)).toBeInTheDocument();
    expect(screen.getByText(mockEnglish.com_upload_limits_summary)).toBeInTheDocument();
    expect(screen.queryByText(/This allowance applies to this guest account/)).toBeNull();
    rendered.unmount();
  });

  it('formats quota, transfer and retention with German UI despite English browser language', async () => {
    mockLocale = 'de';
    mockUser = { id: 'guest-user', provider: 'browser' };
    jest.spyOn(navigator, 'language', 'get').mockReturnValue('en-US');
    const releaseAt = '2026-10-15T13:14:15.000Z';
    const transferring = {
      ...operation,
      state: 'transferring' as const,
      canRetryProcessing: false,
    };
    read.mockResolvedValue({
      ...snapshot,
      operations: [transferring],
      usage: {
        ...snapshot.usage,
        usedBytes: 1.5 * 1_048_576,
        nextReleaseAt: releaseAt,
        nextReleaseBytes: 4 * 1_048_576,
      },
    });
    const rendered = view({
      ...file,
      managedUpload: {
        phase: 'transferring',
        operation: transferring,
        transfer: {
          loaded: 1.5 * 1_048_576,
          total: 3 * 1_048_576,
          percent: 50,
          bytesPerSecond: 0.5 * 1_048_576,
          remainingSeconds: 3,
        },
      },
    });
    expect(await screen.findByText('1,5 MiB')).toBeInTheDocument();
    expect(screen.getByText('1,5 / 3 MiB · 50 %')).toBeInTheDocument();
    expect(screen.getByText('0,5 MiB/s · noch etwa 3 Sekunden')).toBeInTheDocument();
    expect(
      screen.getByText(
        `Als Nächstes werden 4 MiB am ${new Date(releaseAt).toLocaleString('de')} wieder verfügbar.`,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(`Aufbewahrung bis ${new Date(operation.expiresAt!).toLocaleString('de')}`),
    ).toBeInTheDocument();
    rendered.unmount();
  });
});
