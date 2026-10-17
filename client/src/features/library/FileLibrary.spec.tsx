import userEvent from '@testing-library/user-event';
import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FileSources } from 'librechat-data-provider';
import type { FileLibraryItem, FileLibraryPage } from 'librechat-data-provider';
import { FileLibrary } from './FileLibrary';
import type { FileLibrarySelection } from './FileLibrary';
import { FileLibraryRequestError, getFileLibrary, updateFileLibrary } from './api';

let mockUser = { id: 'owner', tenantId: null as string | null };
let mockEnabled = true;
let mockPrincipal = 'user:owner';
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ i18n: { resolvedLanguage: 'de-DE', language: 'en-US' } }),
}));
jest.mock('~/utils/session', () => ({ getSessionPrincipal: () => mockPrincipal }));
const mockDelete = jest.fn();
jest.mock('recoil', () => ({
  useRecoilValue: (atom: string) => (atom === 'user' ? mockUser : mockEnabled),
}));
jest.mock('~/store', () => ({
  __esModule: true,
  default: { user: 'user', queriesEnabled: 'enabled' },
}));
jest.mock('~/hooks/useLocalize', () => ({
  __esModule: true,
  default: () => (key: string, options?: object) =>
    [key, ...Object.values(options ?? {})].join(' '),
}));
jest.mock('~/data-provider/Files/mutations', () => ({
  useDeleteFilesMutation: () => ({ mutateAsync: mockDelete }),
}));
jest.mock('~/components/Chat/Input/Files/Table/FileSourceButton', () => ({
  __esModule: true,
  default: ({ file }: { file: FileLibraryItem }) => <button>{file.filename}</button>,
}));
jest.mock('./api', () => ({
  getFileLibrary: jest.fn(),
  updateFileLibrary: jest.fn(),
  FileLibraryRequestError: jest.requireActual('./api').FileLibraryRequestError,
}));
jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  ...jest.requireActual('../../../../packages/data-provider/src/file-library'),
}));

const getPage = jest.mocked(getFileLibrary);
const update = jest.mocked(updateFileLibrary);
const first: FileLibraryItem = {
  file_id: 'first',
  filename: 'first.txt',
  user: 'owner',
  type: 'text/plain',
  bytes: 2,
  embedded: false,
  filepath: '/api/files/download/first',
  object: 'file',
  usage: 0,
  source: FileSources.local,
  library: { tags: ['old'], archivedAt: null, revision: 0 },
};
const second: FileLibraryItem = { ...first, file_id: 'second', filename: 'second.txt' };
const page = (files = [first, second], nextCursor: string | null = null): FileLibraryPage => ({
  files,
  nextCursor,
});
let client: QueryClient;
beforeEach(() => {
  mockUser = { id: 'owner', tenantId: null };
  mockEnabled = true;
  mockPrincipal = 'user:owner';
  client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
    logger: { log: console.log, warn: console.warn, error: jest.fn() },
  });
  getPage.mockReset().mockResolvedValue(page());
  update.mockReset().mockResolvedValue({ tags: [], archivedAt: null, revision: 1 });
  mockDelete.mockReset().mockResolvedValue({ failedFileIds: [] });
});
afterEach(() => client.clear());
function view(renderSelectionActions?: (selection: FileLibrarySelection) => React.ReactNode) {
  return render(<FileLibrary renderSelectionActions={renderSelectionActions} />, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}
async function select(name = 'first.txt') {
  await userEvent.click(screen.getByRole('checkbox', { name: `com_library_select_file ${name}` }));
}

it('renders dates and sizes using the resolved product locale instead of the browser default', async () => {
  getPage.mockResolvedValue(
    page([
      {
        ...first,
        updatedAt: new Date(2026, 9, 17, 12).toISOString(),
        bytes: 1234 * 1024,
      },
    ]),
  );
  view();
  expect(await screen.findByText('17.10.2026')).toBeVisible();
  expect(screen.getByText('com_library_size_kb 1.234')).toBeVisible();
  expect(screen.queryByText('10/17/2026')).toBeNull();
  expect(screen.queryByText('com_library_size_kb 1,234')).toBeNull();
});

it('waits for authentication and a fresh result; disabled users never receive cached rows', async () => {
  mockEnabled = false;
  client.setQueryData(['fileLibrary', 'owner', null, { limit: 25, archive: 'active' }], page());
  const rendered = view();
  expect(screen.queryByText('first.txt')).toBeNull();
  expect(getPage).not.toHaveBeenCalled();
  let resolve!: (value: FileLibraryPage) => void;
  getPage.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  mockEnabled = true;
  rendered.rerender(<FileLibrary />);
  expect(screen.queryByText('first.txt')).toBeNull();
  await act(async () => resolve(page()));
  expect(await screen.findByText('first.txt')).toBeVisible();
});

it('submits server filters and follows bounded cursors with page-local selection', async () => {
  const user = userEvent.setup();
  getPage.mockResolvedValue(page([first], 'aaaaaaaaaaaaaaaaaaaaaaaa'));
  view();
  await screen.findByText('first.txt');
  await select();
  await user.click(screen.getByRole('button', { name: 'com_library_next' }));
  await waitFor(() =>
    expect(getPage).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: 'aaaaaaaaaaaaaaaaaaaaaaaa', limit: 25 }),
      expect.any(AbortSignal),
    ),
  );
  await screen.findByText('first.txt');
  expect(
    screen.getByRole('checkbox', { name: 'com_library_select_file first.txt' }),
  ).not.toBeChecked();
  await user.type(screen.getByRole('textbox', { name: 'com_library_search' }), 'budget');
  await user.type(screen.getByRole('textbox', { name: 'com_library_tag_filter' }), 'Finance');
  await user.selectOptions(
    screen.getByRole('combobox', { name: 'com_library_type' }),
    'application/pdf',
  );
  await user.selectOptions(screen.getByRole('combobox', { name: 'com_library_view' }), 'archived');
  await user.click(screen.getByRole('button', { name: 'com_library_apply' }));
  await waitFor(() =>
    expect(getPage).toHaveBeenLastCalledWith(
      { search: 'budget', tag: 'Finance', type: 'application/pdf', archive: 'archived', limit: 25 },
      expect.any(AbortSignal),
    ),
  );
});

it('retains ID selection across reordered refreshes and archives only the actual selection', async () => {
  view();
  await screen.findByText('first.txt');
  await select();
  getPage.mockResolvedValue(page([second, first]));
  await userEvent.click(screen.getByRole('button', { name: 'com_library_refresh' }));
  await waitFor(() =>
    expect(
      screen.getByRole('checkbox', { name: 'com_library_select_file first.txt' }),
    ).toBeChecked(),
  );
  await userEvent.click(screen.getByRole('button', { name: 'com_library_archive' }));
  await waitFor(() =>
    expect(update).toHaveBeenCalledWith(
      'first',
      { expectedRevision: 0, archived: true },
      expect.any(AbortSignal),
    ),
  );
  expect(update).toHaveBeenCalledTimes(1);
});

it('hides cached data after a failed refetch and recovers only from a fresh response', async () => {
  view();
  await screen.findByText('first.txt');
  getPage.mockRejectedValueOnce(new FileLibraryRequestError(403));
  await userEvent.click(screen.getByRole('button', { name: 'com_library_refresh' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('com_ui_table_error_description');
  expect(screen.queryByText('first.txt')).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));
  expect(await screen.findByText('first.txt')).toBeVisible();
});

it('keeps a tag draft through CAS conflict and requires review before a deliberate retry', async () => {
  const user = userEvent.setup();
  view();
  await screen.findByText('first.txt');
  await select();
  await user.click(screen.getByRole('button', { name: 'com_library_edit_tags' }));
  const input = screen.getByRole('textbox', { name: 'com_library_edit_tags_for first.txt' });
  await user.clear(input);
  await user.type(input, 'My draft');
  update.mockRejectedValueOnce(new FileLibraryRequestError(409));
  getPage.mockResolvedValue(
    page([{ ...first, library: { tags: ['Other tab'], archivedAt: null, revision: 1 } }, second]),
  );
  await user.click(screen.getByRole('button', { name: 'com_ui_save' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'com_library_reviewed' })).toBeEnabled(),
  );
  expect(input).toHaveValue('My draft');
  expect(screen.getByRole('button', { name: 'com_ui_save' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'com_library_reviewed' }));
  await user.click(screen.getByRole('button', { name: 'com_ui_save' }));
  await waitFor(() =>
    expect(update).toHaveBeenLastCalledWith(
      'first',
      { expectedRevision: 1, tags: ['My draft'] },
      expect.any(AbortSignal),
    ),
  );
});

it('clears rows, drafts, selection and cache when user or tenant changes, aborting old reads', async () => {
  const rendered = view();
  await screen.findByText('first.txt');
  await select();
  let resolve!: (value: FileLibraryPage) => void;
  getPage.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  mockUser = { id: 'another', tenantId: 'other' };
  rendered.rerender(<FileLibrary />);
  expect(screen.queryByText('first.txt')).toBeNull();
  await act(async () => resolve(page([second])));
  expect(await screen.findByText('second.txt')).toBeVisible();
  expect(
    screen.getByRole('checkbox', { name: 'com_library_select_file second.txt' }),
  ).not.toBeChecked();
  await waitFor(() =>
    expect(client.getQueriesData(['fileLibrary', 'owner', null])).toHaveLength(0),
  );
});

it('preserves failed delete targets and does not treat HTTP success as complete deletion', async () => {
  view();
  await screen.findByText('first.txt');
  await userEvent.click(screen.getByRole('checkbox', { name: 'com_library_select_page' }));
  mockDelete.mockResolvedValue({ failedFileIds: ['second'] });
  getPage.mockResolvedValue(page([second]));
  await userEvent.click(screen.getByRole('button', { name: 'com_ui_delete' }));
  await userEvent.click(screen.getByRole('button', { name: 'com_library_delete_originals' }));
  await waitFor(() =>
    expect(
      screen.getByRole('checkbox', { name: 'com_library_select_file second.txt' }),
    ).toBeChecked(),
  );
  expect(screen.getByText('com_ui_delete_partial_failure')).toBeVisible();
  expect(mockDelete.mock.calls[0][0].files.map((file: FileLibraryItem) => file.file_id)).toEqual([
    'first',
    'second',
  ]);
});

it('exports only current selected canonical rows to a host and clears only confirmed IDs', async () => {
  const host = jest.fn(({ files, disabled, clearSelection }: FileLibrarySelection) => (
    <button disabled={disabled || !files.length} onClick={() => clearSelection(['first'])}>
      {'confirm-first'}
    </button>
  ));
  view(host);
  await screen.findByText('first.txt');
  await userEvent.click(screen.getByRole('checkbox', { name: 'com_library_select_page' }));
  expect(host).toHaveBeenLastCalledWith(
    expect.objectContaining({ files: [first, second], disabled: false }),
  );
  await userEvent.click(screen.getByRole('button', { name: 'confirm-first' }));
  expect(
    screen.getByRole('checkbox', { name: 'com_library_select_file first.txt' }),
  ).not.toBeChecked();
  expect(
    screen.getByRole('checkbox', { name: 'com_library_select_file second.txt' }),
  ).toBeChecked();
});

it('can advance an empty intermediate page and explicitly unarchive selected rows', async () => {
  getPage
    .mockResolvedValueOnce(page([], 'aaaaaaaaaaaaaaaaaaaaaaaa'))
    .mockResolvedValue(
      page([
        { ...first, library: { tags: [], revision: 4, archivedAt: '2026-10-17T00:00:00.000Z' } },
      ]),
    );
  view();
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'com_library_next' })).toBeEnabled(),
  );
  await userEvent.click(screen.getByRole('button', { name: 'com_library_next' }));
  await screen.findByText('first.txt');
  await select();
  await userEvent.click(screen.getByRole('button', { name: 'com_library_restore' }));
  await waitFor(() =>
    expect(update).toHaveBeenCalledWith(
      'first',
      { expectedRevision: 4, archived: false },
      expect.any(AbortSignal),
    ),
  );
});

it('retains selection after an unknown delete outcome and does not replay automatically', async () => {
  view();
  await screen.findByText('first.txt');
  await select();
  mockDelete.mockRejectedValue(new Error('connection lost'));
  await userEvent.click(screen.getByRole('button', { name: 'com_ui_delete' }));
  await userEvent.click(screen.getByRole('button', { name: 'com_library_delete_originals' }));
  await waitFor(() =>
    expect(
      screen.getByRole('checkbox', { name: 'com_library_select_file first.txt' }),
    ).toBeChecked(),
  );
  expect(screen.getByText('com_library_action_uncertain')).toBeVisible();
  expect(mockDelete).toHaveBeenCalledTimes(1);
});

it('aborts the old identity request and ignores its late response', async () => {
  let finishOld!: (value: FileLibraryPage) => void;
  getPage
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finishOld = resolve;
      }),
    )
    .mockResolvedValue(page([second]));
  const rendered = view();
  await waitFor(() => expect(getPage).toHaveBeenCalledTimes(1));
  const oldSignal = getPage.mock.calls[0][1];
  mockUser = { id: 'owner', tenantId: 'new-tenant' };
  rendered.rerender(<FileLibrary />);
  expect(oldSignal.aborted).toBe(true);
  expect(await screen.findByText('second.txt')).toBeVisible();
  await act(async () => finishOld(page([first])));
  expect(screen.queryByText('first.txt')).toBeNull();
});

it('bounds native delete batches to ten and stops on an unknown batch without losing remaining targets', async () => {
  const files = Array.from({ length: 25 }, (_, index) => ({
    ...first,
    file_id: `file-${index}`,
    filename: `file-${index}.txt`,
  }));
  getPage.mockResolvedValue(page(files));
  view();
  await screen.findByText('file-0.txt');
  await userEvent.click(screen.getByRole('checkbox', { name: 'com_library_select_page' }));
  mockDelete
    .mockResolvedValueOnce({ failedFileIds: [] })
    .mockRejectedValueOnce(new Error('unknown second batch'));
  await userEvent.click(screen.getByRole('button', { name: 'com_ui_delete' }));
  await userEvent.click(screen.getByRole('button', { name: 'com_library_delete_originals' }));
  await waitFor(() =>
    expect(
      screen.getByRole('checkbox', { name: 'com_library_select_file file-24.txt' }),
    ).toBeChecked(),
  );
  expect(
    screen.getByRole('checkbox', { name: 'com_library_select_file file-0.txt' }),
  ).not.toBeChecked();
  expect(
    screen.getByRole('checkbox', { name: 'com_library_select_file file-10.txt' }),
  ).toBeChecked();
  expect(mockDelete).toHaveBeenCalledTimes(2);
  expect(mockDelete.mock.calls.map(([body]) => body.files.length)).toEqual([10, 10]);
  expect(screen.getByText('com_library_action_uncertain')).toBeVisible();
});

it('blocks an initial mutation when the header principal changes before React publishes the user', async () => {
  view();
  await screen.findByText('first.txt');
  await select();
  mockPrincipal = 'user:other';
  await userEvent.click(screen.getByRole('button', { name: 'com_library_archive' }));
  expect(update).not.toHaveBeenCalled();
  expect(screen.queryByText('first.txt')).toBeNull();
  expect(getPage).toHaveBeenCalledTimes(1);
});

it('stops metadata batches and old-owner refetch when only the header principal changes', async () => {
  view();
  await screen.findByText('first.txt');
  await userEvent.click(screen.getByRole('checkbox', { name: 'com_library_select_page' }));
  update.mockImplementationOnce(async () => {
    mockPrincipal = 'user:other';
    return { tags: [], archivedAt: '2026-10-17T00:00:00.000Z', revision: 1 };
  });
  await userEvent.click(screen.getByRole('button', { name: 'com_library_archive' }));
  await waitFor(() => expect(screen.queryByText('first.txt')).toBeNull());
  expect(update).toHaveBeenCalledTimes(1);
  expect(getPage).toHaveBeenCalledTimes(1);
});

it('stops native delete batches when the header changes before user state', async () => {
  getPage.mockResolvedValue(
    page(
      Array.from({ length: 25 }, (_, index) => ({
        ...first,
        file_id: `f-${index}`,
        filename: `f-${index}.txt`,
      })),
    ),
  );
  view();
  await screen.findByText('f-0.txt');
  await userEvent.click(screen.getByRole('checkbox', { name: 'com_library_select_page' }));
  mockDelete.mockImplementationOnce(async () => {
    mockPrincipal = 'user:other';
    return { failedFileIds: [] };
  });
  await userEvent.click(screen.getByRole('button', { name: 'com_ui_delete' }));
  await userEvent.click(screen.getByRole('button', { name: 'com_library_delete_originals' }));
  await waitFor(() => expect(screen.queryByText('f-0.txt')).toBeNull());
  expect(mockDelete).toHaveBeenCalledTimes(1);
  expect(getPage).toHaveBeenCalledTimes(1);
});

it('cancels and withholds pending library work at the native session-ending event', async () => {
  let finish!: (value: FileLibraryPage) => void;
  getPage.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  view();
  await waitFor(() => expect(getPage).toHaveBeenCalledTimes(1));
  const signal = getPage.mock.calls[0][1];
  act(() => {
    window.dispatchEvent(new Event('librechat:auth-session-ending'));
  });
  expect(signal.aborted).toBe(true);
  await act(async () => finish(page()));
  expect(screen.queryByText('first.txt')).toBeNull();
});
