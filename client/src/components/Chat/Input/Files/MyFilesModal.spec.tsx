import { useState } from 'react';
import userEvent from '@testing-library/user-event';
import { FileSources, QueryKeys } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render as renderView, screen, waitFor } from '@testing-library/react';
import type { TFile } from 'librechat-data-provider';
import { MyFilesModal } from './MyFilesModal';

const mockGetFiles = jest.fn();
let mockQueriesEnabled = true;
jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: { ...actual.dataService, getFiles: (...args: unknown[]) => mockGetFiles(...args) },
  };
});
jest.mock('~/data-provider', () => jest.requireActual('~/data-provider/Files/queries'));
jest.mock('recoil', () => ({ useRecoilValue: () => mockQueriesEnabled }));
jest.mock('~/store', () => ({ queriesEnabled: {} }));
jest.mock('~/common', () => ({ isEphemeralAgent: () => false }));
jest.mock('~/utils', () => ({}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('./Table', () => ({
  columns: [],
  DataTable: ({ data }: { data: TFile[] }) => (
    <div data-testid="files-table">
      <input aria-label="existing-table-filter" />
      {data.length
        ? data.map((file) => <span key={file.file_id}>{file.filename}</span>)
        : 'com_files_no_results'}
    </div>
  ),
}));

let client: QueryClient;

beforeEach(() => {
  mockQueriesEnabled = true;
  client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
    logger: { log: console.log, warn: console.warn, error: jest.fn() },
  });
  mockGetFiles.mockReset().mockResolvedValue([]);
});
afterEach(() => client.clear());

function render(ui: React.ReactElement) {
  return renderView(ui, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}

const file = Object.freeze({
  file_id: 'native-file',
  filename: 'authorized.txt',
  source: FileSources.firebase,
  type: 'text/plain',
  bytes: 2,
  user: 'owner',
  embedded: false,
  filepath: '/not-used',
  object: 'file',
  usage: 0,
} satisfies TFile);

function Harness({ trigger }: { trigger: HTMLElement }) {
  const [open, setOpen] = useState(true);
  return <MyFilesModal open={open} onOpenChange={setOpen} triggerRef={{ current: trigger }} />;
}

describe('MyFilesModal focus restoration', () => {
  it('returns focus to the shortcut invoker instead of the account button', async () => {
    const user = userEvent.setup();
    const invoker = document.createElement('button');
    const inertSidebar = document.createElement('div');
    const accountButton = document.createElement('button');
    inertSidebar.setAttribute('inert', '');
    inertSidebar.append(accountButton);
    document.body.append(invoker, inertSidebar);
    invoker.focus();

    render(<Harness trigger={accountButton} />);
    await user.click(await screen.findByRole('button', { name: 'Close' }));

    await waitFor(() => expect(invoker).toHaveFocus());
  });

  it('falls back to the account button when the dialog opens from its menu', async () => {
    const user = userEvent.setup();
    const menu = document.createElement('div');
    const menuItem = document.createElement('button');
    const accountButton = document.createElement('button');
    menu.setAttribute('role', 'menu');
    menu.append(menuItem);
    document.body.append(menu, accountButton);
    menuItem.focus();

    render(<Harness trigger={accountButton} />);
    await user.click(await screen.findByRole('button', { name: 'Close' }));

    await waitFor(() => expect(accountButton).toHaveFocus());
  });
});

describe('MyFilesModal server refresh', () => {
  it('keeps cached private rows hidden while authenticated queries are disabled', async () => {
    mockQueriesEnabled = false;
    client.setQueryData([QueryKeys.files], [file]);
    const view = render(<MyFilesModal open onOpenChange={jest.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('com_ui_loading');
    expect(screen.queryByText(file.filename)).toBeNull();
    expect(mockGetFiles).not.toHaveBeenCalled();
    mockQueriesEnabled = true;
    view.rerender(<MyFilesModal open onOpenChange={jest.fn()} />);
    await waitFor(() => expect(screen.getByTestId('files-table')).toBeVisible());
    expect(screen.getByText('com_files_no_results')).toBeVisible();
  });

  it('hides cached rows until fresh authorization completes and does not mutate cached files', async () => {
    client.setQueryData([QueryKeys.files], [file]);
    let resolve!: (files: TFile[]) => void;
    mockGetFiles.mockReturnValue(
      new Promise<TFile[]>((done) => {
        resolve = done;
      }),
    );
    render(<MyFilesModal open onOpenChange={jest.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('com_ui_loading');
    expect(screen.queryByText(file.filename)).toBeNull();
    await act(async () => resolve([file]));
    expect(await screen.findByText(file.filename)).toBeInTheDocument();
    expect(file).not.toHaveProperty('context');
    expect(file).not.toHaveProperty('filterSource');
    expect(client.getQueryData<TFile[]>([QueryKeys.files])?.[0]).toBe(file);
  });

  it('refreshes on every opening and renders an empty server result without old rows', async () => {
    mockGetFiles.mockResolvedValueOnce([file]).mockResolvedValueOnce([]);
    const view = render(<MyFilesModal open={false} onOpenChange={jest.fn()} />);
    expect(mockGetFiles).not.toHaveBeenCalled();
    view.rerender(<MyFilesModal open onOpenChange={jest.fn()} />);
    expect(await screen.findByText(file.filename)).toBeInTheDocument();
    view.rerender(<MyFilesModal open={false} onOpenChange={jest.fn()} />);
    view.rerender(<MyFilesModal open onOpenChange={jest.fn()} />);
    await waitFor(() => expect(screen.getByTestId('files-table')).toBeVisible());
    expect(screen.getByText('com_files_no_results')).toBeVisible();
    expect(screen.queryByText(file.filename)).toBeNull();
    expect(mockGetFiles).toHaveBeenCalledTimes(2);
  });

  it('does not show cached private rows after a failed refresh and retries from the server', async () => {
    const user = userEvent.setup();
    client.setQueryData([QueryKeys.files], [file]);
    mockGetFiles.mockRejectedValueOnce(new Error('server unavailable')).mockResolvedValueOnce([]);
    render(<MyFilesModal open onOpenChange={jest.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('com_ui_table_error_description');
    expect(screen.queryByText(file.filename)).toBeNull();
    expect(screen.getByTestId('files-table')).not.toBeVisible();
    await user.click(screen.getByRole('button', { name: 'com_ui_retry' }));
    await waitFor(() => expect(screen.getByTestId('files-table')).toBeVisible());
    expect(screen.getByText('com_files_no_results')).toBeVisible();
    expect(mockGetFiles).toHaveBeenCalledTimes(2);
  });

  it('preserves native table state across a background refresh while withholding old rows', async () => {
    const user = userEvent.setup();
    mockGetFiles.mockResolvedValueOnce([file]);
    render(<MyFilesModal open onOpenChange={jest.fn()} />);
    expect(await screen.findByText(file.filename)).toBeVisible();
    const filter = screen.getByRole('textbox', { name: 'existing-table-filter' });
    await user.type(filter, 'report');
    let resolve!: (files: TFile[]) => void;
    mockGetFiles.mockReturnValueOnce(
      new Promise<TFile[]>((done) => {
        resolve = done;
      }),
    );
    act(() => {
      void client.invalidateQueries([QueryKeys.files]);
    });
    expect(await screen.findByRole('status')).toHaveTextContent('com_ui_loading');
    expect(screen.queryByText(file.filename)).toBeNull();
    await act(async () => resolve([file]));
    await waitFor(() => expect(filter).toBeVisible());
    expect(screen.getByRole('textbox', { name: 'existing-table-filter' })).toBe(filter);
    expect(filter).toHaveValue('report');
  });
});
