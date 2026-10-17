/** Real table selection must keep deletion bound to file identity when refreshed rows move. */
import { RecoilRoot } from 'recoil';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { FileSources } from 'librechat-data-provider';
import type { ColumnDef } from '@tanstack/react-table';
import type { TFile } from 'librechat-data-provider';
import i18n from '~/locales/i18n';
import DataTable from './DataTable';

const mockDeleteRequest = jest.fn();
jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      deleteFiles: (...args: unknown[]) => mockDeleteRequest(...args),
    },
  };
});

// Fixture columns use the same native row-selection API as Columns.tsx. The table,
// TanStack selection, filtering, sorting, virtualization and deletion hooks stay real.
const columns: ColumnDef<TFile>[] = [
  {
    id: 'select',
    enableHiding: false,
    cell: ({ row }) => (
      <input
        type="checkbox"
        aria-label={`Select ${row.original.file_id}`}
        checked={row.getIsSelected()}
        onChange={(event) => row.toggleSelected(event.target.checked)}
      />
    ),
  },
  {
    accessorKey: 'filename',
    header: ({ column }) => (
      <button type="button" onClick={() => column.toggleSorting()}>
        {'Sort filenames'}
      </button>
    ),
    cell: ({ row }) => row.original.filename,
  },
];

const file = (id: string, filename: string): TFile => ({
  file_id: id,
  filename,
  source: FileSources.s3,
  type: 'text/plain',
  bytes: 3,
  user: 'owner',
  embedded: true,
  filepath: `/api/files/managed/${id}`,
  object: 'file',
  usage: 0,
});

let client: QueryClient;
const originalGetAnimations = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

beforeEach(() => {
  localStorage.clear();
  client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  mockDeleteRequest.mockResolvedValue({ message: 'Deleted', failedFileIds: [] });
  // jsdom supplies no geometry; let the real virtualizer display these short lists.
  jest.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1024);
  jest.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(520);
  Object.defineProperty(Element.prototype, 'getAnimations', {
    configurable: true,
    value: jest.fn(() => []),
  });
  jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 1024,
    bottom: 52,
    width: 1024,
    height: 52,
    toJSON: () => ({}),
  });
});

afterEach(() => {
  client.clear();
  if (originalGetAnimations)
    Object.defineProperty(Element.prototype, 'getAnimations', originalGetAnimations);
  else Reflect.deleteProperty(Element.prototype, 'getAnimations');
});

function table(files: TFile[]) {
  return render(<DataTable columns={columns} data={files} />, {
    wrapper: ({ children }) => (
      <RecoilRoot>
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      </RecoilRoot>
    ),
  });
}

const selection = (id: string) => screen.getByRole('checkbox', { name: `Select ${id}` });
const deleteButton = () => screen.getByRole('button', { name: 'Delete' });
const requestedIds = () =>
  mockDeleteRequest.mock.calls
    .flatMap(([body]) => body.files.map((item: TFile) => item.file_id))
    .sort();

describe('personal file deletion selection', () => {
  it('deletes the selected original after a refresh reverses row order', async () => {
    const user = userEvent.setup();
    const a = file('original-a', 'alpha.txt');
    const b = file('original-b', 'beta.txt');
    const view = table([a, b]);
    await user.click(await screen.findByRole('checkbox', { name: 'Select original-a' }));
    view.rerender(<DataTable columns={columns} data={[]} />);
    expect(deleteButton()).toBeDisabled();
    view.rerender(<DataTable columns={columns} data={[b, a]} />);
    await user.click(deleteButton());
    await waitFor(() => expect(requestedIds()).toEqual([a.file_id]), { timeout: 2500 });
  });

  it('does not transfer selection to a remaining file when the selected file disappears', async () => {
    const user = userEvent.setup();
    const a = file('removed-a', 'alpha.txt');
    const b = file('remaining-b', 'beta.txt');
    const view = table([a, b]);
    await user.click(await screen.findByRole('checkbox', { name: 'Select removed-a' }));
    view.rerender(<DataTable columns={columns} data={[b]} />);
    expect(selection(b.file_id)).not.toBeChecked();
    expect(deleteButton()).toBeDisabled();
    expect(mockDeleteRequest).not.toHaveBeenCalled();
    await user.click(selection(b.file_id));
    await user.click(deleteButton());
    await waitFor(() => expect(requestedIds()).toEqual([b.file_id]), { timeout: 2500 });
  });

  it('keeps multiple same-name files distinct when a new same-name row arrives', async () => {
    const user = userEvent.setup();
    const a = file('same-a', 'report.txt');
    const b = file('same-b', 'report.txt');
    const c = file('same-c', 'report.txt');
    const view = table([a, b]);
    await user.click(await screen.findByRole('checkbox', { name: 'Select same-a' }));
    await user.click(selection(b.file_id));
    view.rerender(<DataTable columns={columns} data={[]} />);
    view.rerender(<DataTable columns={columns} data={[c, b, a]} />);
    await user.click(deleteButton());
    await waitFor(() => expect(requestedIds()).toEqual([a.file_id, b.file_id]), { timeout: 2500 });
  });

  it('preserves sorting and filter-scoped deletion without selecting hidden files', async () => {
    const user = userEvent.setup();
    const a = file('filter-a', 'alpha.txt');
    const b = file('filter-b', 'beta.txt');
    const view = table([a, b]);
    await user.click(await screen.findByRole('checkbox', { name: 'Select filter-a' }));
    await user.click(selection(b.file_id));
    await user.click(screen.getByRole('button', { name: 'Sort filenames' }));
    await user.click(screen.getByRole('button', { name: 'Sort filenames' }));
    expect(screen.getAllByRole('checkbox', { name: /^Select / })).toEqual([
      selection(b.file_id),
      selection(a.file_id),
    ]);
    view.rerender(<DataTable columns={columns} data={[]} />);
    view.rerender(<DataTable columns={columns} data={[b, a]} />);
    expect(screen.getAllByRole('checkbox', { name: /^Select / })).toEqual([
      selection(b.file_id),
      selection(a.file_id),
    ]);
    await user.type(screen.getByRole('textbox', { name: 'Filter files...' }), 'alpha');
    expect(selection(a.file_id)).toBeChecked();
    expect(screen.queryByRole('checkbox', { name: 'Select filter-b' })).not.toBeInTheDocument();
    view.rerender(<DataTable columns={columns} data={[]} />);
    view.rerender(<DataTable columns={columns} data={[b, a]} />);
    await user.click(deleteButton());
    await waitFor(() => expect(requestedIds()).toEqual([a.file_id]), { timeout: 2500 });
  });
});
