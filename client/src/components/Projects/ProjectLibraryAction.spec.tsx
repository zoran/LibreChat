/** Real native mutation/query hooks with controlled HTTP outcomes and a real React Query cache. */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { dataService, QueryKeys, FileContext, FileSources } from 'librechat-data-provider';
import type { FileLibraryItem, TChatProject } from 'librechat-data-provider';
import ProjectLibraryAction from './ProjectLibraryAction';

let mockUser = { id: 'owner', tenantId: null as string | null };
let mockPrincipal = 'user:owner';
jest.mock('~/hooks/AuthContext', () => ({ useAuthContext: () => ({ user: mockUser }) }));
jest.mock('~/hooks/useLocalize', () => ({
  __esModule: true,
  default: () => (key: string, options?: object) =>
    [key, ...Object.values(options ?? {})].join(' '),
}));
jest.mock('~/utils/session', () => ({ getSessionPrincipal: () => mockPrincipal }));
jest.mock('~/utils', () => ({}));
jest.mock('~/features/library', () => ({
  fileLibraryKey: jest.requireActual('~/features/library/useFileLibrary').fileLibraryKey,
}));
jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    ...jest.requireActual('../../../../packages/data-provider/src/file-library'),
    dataService: {
      ...actual.dataService,
      addProjectFile: jest.fn(),
      getProjectById: jest.fn(),
      getProjectFiles: jest.fn(),
      listProjects: jest.fn(),
    },
  };
});
const post = jest.mocked(dataService.addProjectFile);
const read = jest.mocked(dataService.getProjectById);
const members = jest.mocked(dataService.getProjectFiles);
const list = jest.mocked(dataService.listProjects);
const item = (id: string): FileLibraryItem => ({
  file_id: id,
  filename: `${id}.txt`,
  type: 'text/plain',
  bytes: 1,
  user: 'owner',
  source: FileSources.local,
  context: FileContext.message_attachment,
  embedded: true,
  filepath: `/api/files/download/${id}`,
  object: 'file',
  usage: 0,
  library: { tags: [], archivedAt: null, revision: 0 },
});
const project = (ids: string[], id = 'project-a'): TChatProject => ({
  _id: id,
  name: id,
  file_ids: ids,
  contextRevision: ids.length,
  conversationCount: 0,
  createdAt: '',
  updatedAt: '',
});
let client: QueryClient;
let clear: jest.Mock;
beforeEach(() => {
  mockUser = { id: 'owner', tenantId: null };
  mockPrincipal = 'user:owner';
  clear = jest.fn();
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
  });
  post
    .mockReset()
    .mockImplementation(async ({ projectId, file_id }) => project([file_id], projectId));
  read.mockReset().mockResolvedValue(project([]));
  members.mockReset().mockResolvedValue([]);
  list.mockReset().mockResolvedValue({ projects: [project([], 'choice-a')], nextCursor: null });
});
afterEach(() => client.clear());
function view(files = [item('a'), item('b')], projectId: string | undefined = 'project-a') {
  return render(
    <ProjectLibraryAction files={files} projectId={projectId} clearSelection={clear} />,
    {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
}
const submit = () =>
  fireEvent.click(screen.getByRole('button', { name: 'com_library_project_add' }));

it('freezes selected IDs, serializes writes, prevents double dispatch, and clears only confirmed successes', async () => {
  let finish!: (value: TChatProject) => void;
  post
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockRejectedValueOnce({ response: { status: 409, data: { error: 'private detail' } } });
  const shown = view();
  const button = screen.getByRole('button', { name: 'com_library_project_add' });
  fireEvent.click(button);
  fireEvent.click(button);
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  shown.rerender(
    <ProjectLibraryAction files={[item('c')]} projectId="project-a" clearSelection={clear} />,
  );
  await act(async () => {
    finish(project(['a']));
  });
  await waitFor(() => expect(clear).toHaveBeenCalledWith(['a']));
  expect(post.mock.calls.map(([payload]) => payload)).toEqual([
    { projectId: 'project-a', file_id: 'a' },
    { projectId: 'project-a', file_id: 'b' },
  ]);
  expect(screen.getByRole('status')).toHaveTextContent('b.txt: com_library_project_failed');
  expect(screen.queryByText('private detail')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'com_library_project_retry' }));
  await waitFor(() => expect(clear).toHaveBeenLastCalledWith(['b']));
  expect(post).toHaveBeenCalledTimes(3);
});

it('reconciles a lost successful response with fresh native project and availability reads', async () => {
  const invalidate = jest.spyOn(client, 'invalidateQueries');
  post.mockRejectedValueOnce(new Error('lost response'));
  read.mockResolvedValue(project(['a']));
  members.mockResolvedValue([{ file_id: 'a', availability: 'ready' }]);
  client.setQueryData([QueryKeys.project, 'project-a'], project([]));
  view([item('a')]);
  submit();
  await waitFor(() => expect(clear).toHaveBeenCalledWith(['a']));
  expect(read).toHaveBeenCalledWith('project-a');
  expect(members).toHaveBeenCalledWith('project-a');
  expect(invalidate).toHaveBeenCalledWith([QueryKeys.projectFiles, 'project-a']);
  expect(post).toHaveBeenCalledTimes(1);
});

it('keeps unknown outcomes blocked until an explicit fresh read succeeds, then permits retry of absent IDs', async () => {
  post.mockRejectedValueOnce(new Error('lost response'));
  read.mockRejectedValueOnce(new Error('offline'));
  view([item('a')]);
  submit();
  await screen.findByRole('button', { name: 'com_library_project_reconcile' });
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'com_library_project_add' })).toBeDisabled(),
  );
  expect(clear).toHaveBeenCalledWith([]);
  fireEvent.click(screen.getByRole('button', { name: 'com_library_project_reconcile' }));
  await screen.findByRole('button', { name: 'com_library_project_retry' });
  expect(post).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'com_library_project_retry' }));
  await waitFor(() => expect(clear).toHaveBeenLastCalledWith(['a']));
});

it('does not confirm a raw reference that is now unavailable', async () => {
  post.mockRejectedValueOnce(new Error('lost response'));
  read.mockResolvedValue(project(['a']));
  members.mockResolvedValue([{ file_id: 'a', availability: 'unavailable' }]);
  view([item('a')]);
  submit();
  await screen.findByRole('button', { name: 'com_library_project_retry' });
  expect(clear).toHaveBeenCalledWith([]);
});

it.each(['project', 'owner', 'tenant', 'principal', 'unmount'])(
  'ignores late results and stops remaining mutations on %s change',
  async (kind) => {
    let finish!: (value: TChatProject) => void;
    post.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const shown = view();
    submit();
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    if (kind === 'owner') mockUser = { id: 'other', tenantId: null };
    if (kind === 'tenant') mockUser = { id: 'owner', tenantId: 'other' };
    if (kind === 'principal') mockPrincipal = 'user:other';
    if (kind === 'unmount') shown.unmount();
    else
      shown.rerender(
        <ProjectLibraryAction
          files={[item('a'), item('b')]}
          projectId={kind === 'project' ? 'project-b' : 'project-a'}
          clearSelection={clear}
        />,
      );
    await act(async () => {
      finish(project(['a']));
    });
    expect(post).toHaveBeenCalledTimes(1);
    expect(clear).not.toHaveBeenCalled();
  },
);

it('uses the native searchable paginated project list when no fixed project is supplied', async () => {
  list
    .mockResolvedValueOnce({ projects: [project([], 'choice-a')], nextCursor: 'next' })
    .mockResolvedValueOnce({ projects: [project([], 'choice-b')], nextCursor: null });
  render(<ProjectLibraryAction files={[item('a')]} clearSelection={clear} />, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  await screen.findByRole('option', { name: 'choice-a' });
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_load_more' }));
  await screen.findByRole('option', { name: 'choice-b' });
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'choice-b' } });
  submit();
  await waitFor(() => expect(post).toHaveBeenCalledWith({ projectId: 'choice-b', file_id: 'a' }));
});

it('invalidates both native project caches and the public owner/tenant library cache', async () => {
  const invalidate = jest.spyOn(client, 'invalidateQueries');
  view([item('a')]);
  submit();
  await waitFor(() => expect(invalidate).toHaveBeenCalledWith(['fileLibrary', 'owner', null]));
  expect(invalidate).toHaveBeenCalledWith([QueryKeys.projectFiles, 'project-a']);
  expect(invalidate).toHaveBeenCalledWith([QueryKeys.projectAvailableFiles, 'project-a']);
});

it('does not dispatch an old owner selection after the authenticated principal changes', async () => {
  view([item('a')]);
  mockPrincipal = 'user:other';
  submit();
  await act(async () => {});
  expect(post).not.toHaveBeenCalled();
  expect(clear).not.toHaveBeenCalled();
});

it('rejects a batch beyond the canonical bounded library page size', () => {
  view(Array.from({ length: 51 }, (_, index) => item(String(index))));
  expect(screen.getByRole('button', { name: 'com_library_project_add' })).toBeDisabled();
  submit();
  expect(post).not.toHaveBeenCalled();
});
