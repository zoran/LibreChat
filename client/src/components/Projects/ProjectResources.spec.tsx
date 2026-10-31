/** ProjectResources tests preserve reference lifecycle and close every device upload admission path. */
import { useState } from 'react';
import { RecoilRoot } from 'recoil';
import userEvent from '@testing-library/user-event';
import { FileSources, QueryKeys } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TChatProjectFile, FileLibraryItem, TFileUpload } from 'librechat-data-provider';
import type * as ClientModule from '@librechat/client';
import type * as ReactModule from 'react';
import type { ReactNode } from 'react';
import { useDeleteFilesMutation } from '~/data-provider/Files/mutations';
import mockGerman from '~/locales/de/translation.json';
import ProjectResources from './ProjectResources';

const mockUploadMutateAsync = jest.fn();
let mockUploadSessionKey = 'tenant/user';
let mockUploadAdmissionError: string | null = null;
let mockLiveUploadAdmissionError: string | null | undefined;
jest.mock('~/features/uploads/useManagedUploads', () => ({
  useManagedUploads: () => ({
    sessionKey: mockUploadSessionKey,
    newUploadError: mockUploadAdmissionError,
    getNewUploadError: () =>
      mockLiveUploadAdmissionError === undefined
        ? mockUploadAdmissionError
        : mockLiveUploadAdmissionError,
  }),
}));
const mockCanUseFileSearch = jest.fn(() => true);
const mockAddMutateAsync = jest.fn();
const mockRemoveMutateAsync = jest.fn();
const mockRefetch = jest.fn();
const mockShowToast = jest.fn();
const mockPreview = jest.fn();
const mockPreviewBlob = jest.fn().mockResolvedValue({ data: undefined });
const mockGetProjectFiles = jest.fn();
const mockDeleteFiles = jest.fn();
let mockUseNativeProjectQuery = false;
let mockLibraryProps: object;
jest.mock('~/utils/session', () => ({ getSessionPrincipal: () => 'user:user-1' }));
jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getProjectFiles: (...args: unknown[]) => mockGetProjectFiles(...args),
      deleteFiles: (...args: unknown[]) => mockDeleteFiles(...args),
    },
  };
});
jest.mock('~/features/library', () => ({
  FileLibrary: (props: { renderSelectionActions: (selection: object) => ReactNode }) => {
    mockLibraryProps = props;
    return props.renderSelectionActions({
      files: [{ file_id: 'library-file' }],
      disabled: false,
      clearSelection: jest.fn(),
    });
  },
}));
jest.mock('./ProjectLibraryAction', () => ({
  __esModule: true,
  default: ({ projectId, files }: { projectId: string; files: FileLibraryItem[] }) => (
    <div data-testid="membership-action">
      {projectId}:{files.map((file) => file.file_id).join(',')}
    </div>
  ),
}));

let projectFilesState: TChatProjectFile[] = [];
let mockProjectQueryState = {
  data: projectFilesState as TChatProjectFile[] | undefined,
  isLoading: false,
  isError: false,
  refetch: mockRefetch,
};
jest.mock('@librechat/client', () => {
  const React = jest.requireActual<typeof ReactModule>('react');
  const actual = jest.requireActual<typeof ClientModule>('@librechat/client');
  return {
    ...actual,
    Spinner: () => React.createElement('span', { 'aria-hidden': true }),
    Alert: ({ children, role }: React.HTMLAttributes<HTMLDivElement>) =>
      React.createElement('div', { role }, children),
    FileUpload: React.forwardRef<
      HTMLInputElement,
      { children: ReactNode; handleFileChange: React.ChangeEventHandler<HTMLInputElement> }
    >(({ children, handleFileChange }, ref) =>
      React.createElement(
        React.Fragment,
        null,
        children,
        React.createElement('input', {
          ref,
          type: 'file',
          'data-testid': 'project-upload-input',
          onChange: handleFileChange,
        }),
      ),
    ),
    TooltipAnchor: ({ render }: { render: ReactNode }) => render,
    useToastContext: () => ({ showToast: mockShowToast }),
  };
});

jest.mock('~/data-provider', () => ({
  ...jest.requireActual('~/data-provider'),
  useProjectFilesQuery: (
    ...args: Parameters<(typeof import('~/data-provider'))['useProjectFilesQuery']>
  ) =>
    mockUseNativeProjectQuery
      ? jest.requireActual('~/data-provider').useProjectFilesQuery(...args)
      : mockProjectQueryState,
  useUploadFileMutation: () => ({ mutateAsync: mockUploadMutateAsync, isLoading: false }),
  useAddProjectFileMutation: () => ({ mutateAsync: mockAddMutateAsync, isLoading: false }),
  useRemoveProjectFileMutation: () => ({ mutateAsync: mockRemoveMutateAsync, isLoading: false }),
  useGetStartupConfig: () => ({ data: undefined }),
  useFilePreview: (...args: unknown[]) => {
    mockPreview(...args);
    return {
      data: {
        file_id: args[0],
        status: 'ready',
        textFormat: 'text',
        text: `Approved source ${args[0]}`,
      },
      isFetching: false,
      isError: false,
      refetch: jest.fn(),
    };
  },
  useFilePreviewBlob: () => ({ refetch: mockPreviewBlob }),
  useFileDownload: () => ({ refetch: jest.fn() }),
  useSharedFileDownload: () => ({ refetch: jest.fn() }),
}));

jest.mock('~/Providers', () => ({ useShareContext: () => ({}), useFileMapContext: () => ({}) }));
jest.mock('~/components/Messages/Content/CopyButton', () => () => null);

jest.mock('~/hooks', () => ({
  useAgentCapabilities: () => ({ fileSearchEnabled: true }),
  useGetAgentsConfig: () => ({ agentsConfig: { capabilities: ['file_search'] } }),
  useHasAccess: () => mockCanUseFileSearch(),
  useAuthContext: () => ({ user: { id: 'user-1' } }),
  useToolFavorites: () => ({ favoriteKeys: new Set(), toggle: jest.fn() }),
  useLocalize: () => (key: string, options?: { count?: number; name?: string; 0?: string }) => {
    const translations: Record<string, string> = {
      com_upload_storage_unavailable: mockGerman.com_upload_storage_unavailable,
      com_upload_storage_stale: mockGerman.com_upload_storage_stale,
      com_upload_status_unavailable: mockGerman.com_upload_status_unavailable,
      com_upload_admission_paused: mockGerman.com_upload_admission_paused,
      com_upload_quota_exceeded: mockGerman.com_upload_quota_exceeded,
      com_error_files_upload: 'An error occurred while uploading the file.',
      com_error_files_upload_canceled: 'The file upload was canceled.',
      com_ui_project_add_files: 'Add files',
      com_ui_composer_preview_file: `Preview ${options?.[0] ?? ''}`,
      com_ui_project_files: 'Reference files',
      com_ui_project_files_help: 'Files are searched',
      com_ui_project_files_retrieval_only: 'Retrieval only',
      com_ui_project_upload_file: 'Upload file',
      com_ui_project_choose_file: 'Choose an existing file',
      com_ui_search_files: 'Search files',
      com_ui_project_file_processing: 'Processing',
      com_ui_project_file_failed: 'Upload failed',
      com_ui_project_file_ready: 'Ready',
      com_ui_project_file_unavailable: 'Unavailable',
      com_ui_project_file_attach_error: 'Could not add this file',
      com_ui_project_file_remove_error: 'Could not remove this file',
      com_ui_project_file_limit: 'This project can use up to {{count}} reference files.',
      com_ui_project_file_excess: `Could not add ${options?.count ?? ''} selected file(s)`,
      com_ui_project_files_error: 'Could not load project files',
      com_ui_project_no_files: 'No reference files yet',
      com_ui_project_no_eligible_files: 'No eligible indexed files',
      com_ui_project_remove_file: `Remove ${options?.name ?? ''} from project`,
      com_ui_project_dismiss_upload: `Dismiss ${options?.name ?? ''} upload`,
      com_ui_retry: 'Retry',
      com_ui_loading: 'Loading',
      com_ui_load_more: 'Load more',
      com_ui_no_search_results: 'No results match your search',
    };
    return (translations[key] ?? key).replace('{{count}}', String(options?.count ?? ''));
  },
}));

function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={client}>
      <RecoilRoot>{children}</RecoilRoot>
    </QueryClientProvider>
  );
}

const project = { _id: 'project-1', fileCount: 0 };
const uploadedFile = {
  file_id: 'canonical-file-id',
  temp_file_id: 'different-temporary-id',
  filename: 'reference.txt',
  bytes: 10,
  embedded: true,
  context: 'message_attachment',
  type: 'text/plain',
} as unknown as TFileUpload;

function renderResources() {
  return render(<ProjectResources project={project} />, { wrapper: Providers });
}

describe('ProjectResources', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUploadAdmissionError = null;
    mockLiveUploadAdmissionError = undefined;
    mockUploadSessionKey = 'tenant/user';
    mockUseNativeProjectQuery = false;
    projectFilesState = [];
    mockProjectQueryState = {
      data: projectFilesState,
      isLoading: false,
      isError: false,
      refetch: mockRefetch,
    };
    mockCanUseFileSearch.mockReturnValue(true);
    mockAddMutateAsync.mockResolvedValue({});
    mockRemoveMutateAsync.mockResolvedValue({});
  });

  it('refreshes a mounted ready reference into an unavailable placeholder after a lost original-delete reply', async () => {
    mockUseNativeProjectQuery = true;
    mockGetProjectFiles.mockResolvedValue([
      { file_id: 'source-one', filename: 'reference.txt', availability: 'ready' },
    ]);
    mockDeleteFiles.mockImplementationOnce(async () => {
      mockGetProjectFiles.mockResolvedValue([
        { file_id: 'source-one', availability: 'unavailable' },
      ]);
      throw new Error('response lost after deletion');
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      logger: { log: console.log, warn: console.warn, error: () => undefined },
    });
    const references = { ...project, file_ids: ['source-one'] };
    queryClient.setQueryData([QueryKeys.project, project._id], references);
    const deleteOriginalLabel = 'Delete original';
    function DeleteOriginal() {
      const remove = useDeleteFilesMutation({ silent: true });
      return (
        <button
          onClick={() => {
            void remove
              .mutateAsync({
                files: [
                  {
                    file_id: 'source-one',
                    filepath: '/files/reference.txt',
                    embedded: true,
                    source: FileSources.local,
                  },
                ],
              })
              .catch(() => undefined);
          }}
        >
          {deleteOriginalLabel}
        </button>
      );
    }
    render(
      <QueryClientProvider client={queryClient}>
        <RecoilRoot>
          <ProjectResources project={project} />
          <DeleteOriginal />
        </RecoilRoot>
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('button', { name: 'Preview reference.txt' })).toBeVisible();
    expect(screen.getByText('Ready')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Delete original' }));
    expect(await screen.findByText('Unavailable')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Preview reference.txt' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(mockGetProjectFiles).toHaveBeenCalledTimes(2);
    expect(queryClient.getQueryData([QueryKeys.projectFiles, project._id])).toEqual([
      { file_id: 'source-one', availability: 'unavailable' },
    ]);
    expect(queryClient.getQueryData([QueryKeys.project, project._id])).toEqual(references);
    expect(mockRemoveMutateAsync).not.toHaveBeenCalled();
  });

  it('opens a ready source by exact ID without attaching/removing it and restores focus on Escape', async () => {
    const user = userEvent.setup();
    const filename = `${'Long project reference '.repeat(8)}.txt`;
    mockProjectQueryState.data = [
      {
        file_id: 'source-one',
        filename,
        availability: 'ready',
        type: 'text/plain',
        bytes: 128,
        llmDeliveryPath: 'text',
      },
      {
        file_id: 'source-two',
        filename,
        availability: 'ready',
        type: 'text/plain',
        bytes: 128,
        llmDeliveryPath: 'text',
      },
      {
        file_id: 'unavailable-source',
        filename: 'Unavailable source.txt',
        availability: 'unavailable',
      },
    ];
    renderResources();
    expect(
      screen.queryByRole('button', { name: 'Preview Unavailable source.txt' }),
    ).not.toBeInTheDocument();
    const triggers = screen.getAllByRole('button', { name: `Preview ${filename}` });
    expect(triggers).toHaveLength(2);
    expect(triggers[1]).toHaveAttribute('title', filename);
    triggers[1].focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('dialog', { name: filename })).toBeInTheDocument();
    expect(screen.getByText('Approved source source-two')).toBeInTheDocument();
    expect(screen.queryByText('Approved source source-one')).not.toBeInTheDocument();
    expect(mockPreview).toHaveBeenCalledWith('source-two', { enabled: true }, undefined, 'content');
    expect(mockAddMutateAsync).not.toHaveBeenCalled();
    expect(mockRemoveMutateAsync).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(triggers[1]).toHaveFocus());
    expect(screen.queryByRole('dialog', { name: filename })).not.toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: `Remove ${filename} from project` })[0]);
    expect(mockRemoveMutateAsync).toHaveBeenCalledWith({
      projectId: 'project-1',
      file_id: 'source-one',
    });
  });

  it('renders loading, error, and empty states with recovery controls', () => {
    mockProjectQueryState = { ...mockProjectQueryState, isLoading: true };
    renderResources();
    expect(screen.getByRole('status')).toBeInTheDocument();
    cleanup();

    mockProjectQueryState = { ...mockProjectQueryState, isLoading: false, isError: true };
    renderResources();
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load project files');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(mockRefetch).toHaveBeenCalled();
    cleanup();

    mockProjectQueryState = { ...mockProjectQueryState, isError: false };
    renderResources();
    expect(screen.getByText('No reference files yet')).toBeInTheDocument();
  });

  it('uses the canonical upload identity and exposes pending and failed attempts', async () => {
    let resolveUpload: (file: TFileUpload) => void = () => undefined;
    mockUploadMutateAsync.mockImplementation(
      () => new Promise<TFileUpload>((resolve) => (resolveUpload = resolve)),
    );
    renderResources();
    const input = screen.getByTestId('project-upload-input');
    fireEvent.change(input, { target: { files: [new File(['x'], 'reference.txt')] } });
    expect(screen.getByText('Processing')).toBeInTheDocument();

    resolveUpload(uploadedFile);
    await waitFor(() =>
      expect(mockAddMutateAsync).toHaveBeenCalledWith({
        projectId: 'project-1',
        file_id: 'canonical-file-id',
      }),
    );
    await waitFor(() => expect(screen.queryByText('Processing')).not.toBeInTheDocument());

    mockUploadMutateAsync.mockRejectedValueOnce({
      message: 'unsafe internal upload detail',
      response: { data: { message: 'Images are not supported for File Search.' } },
    });
    fireEvent.change(input, { target: { files: [new File(['y'], 'failed.txt')] } });
    await waitFor(() =>
      expect(screen.getByText('Images are not supported for File Search.')).toBeInTheDocument(),
    );
    expect(screen.queryByText('unsafe internal upload detail')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss failed.txt upload' })).toBeInTheDocument();
  });
  it('reserves remaining capacity across overlapping multi-file selections', async () => {
    let finishFirstUpload!: (file: TFileUpload) => void;
    mockProjectQueryState = { ...mockProjectQueryState, data: undefined, isLoading: true };
    mockUploadMutateAsync
      .mockImplementationOnce(
        () => new Promise<TFileUpload>((resolve) => (finishFirstUpload = resolve)),
      )
      .mockResolvedValueOnce({ ...uploadedFile, file_id: 'second-canonical-id' });
    render(<ProjectResources project={{ ...project, fileCount: 48 }} />, { wrapper: Providers });
    const input = screen.getByTestId('project-upload-input');
    fireEvent.change(input, {
      target: {
        files: [
          new File(['a'], 'first.txt'),
          new File(['b'], 'second.txt'),
          new File(['c'], 'excess.txt'),
        ],
      },
    });
    fireEvent.change(input, { target: { files: [new File(['d'], 'another-excess.txt')] } });
    expect(mockUploadMutateAsync).toHaveBeenCalledTimes(1);
    expect(mockShowToast).toHaveBeenCalledTimes(2);
    expect(mockShowToast).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: 'Could not add 1 selected file(s)' }),
    );
    finishFirstUpload(uploadedFile);
    await waitFor(() => expect(mockAddMutateAsync).toHaveBeenCalledTimes(2));
    expect(mockUploadMutateAsync).toHaveBeenCalledTimes(2);
    expect(mockAddMutateAsync.mock.calls.map(([payload]) => payload.file_id)).toEqual([
      uploadedFile.file_id,
      'second-canonical-id',
    ]);
  });

  it('retries a failed association without uploading another binary', async () => {
    mockUploadMutateAsync.mockResolvedValue(uploadedFile);
    mockAddMutateAsync.mockRejectedValueOnce({
      message: 'unsafe association detail',
      response: { status: 409, data: { error: 'Project file limit reached' } },
    });
    renderResources();
    fireEvent.change(screen.getByTestId('project-upload-input'), {
      target: { files: [new File(['x'], 'reference.txt')] },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This project can use up to 50 reference files.',
    );
    expect(screen.queryByText('Project file limit reached')).not.toBeInTheDocument();
    expect(screen.queryByText('unsafe association detail')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByText('Upload failed')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByText('Processing')).not.toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(mockUploadMutateAsync).toHaveBeenCalledTimes(1);
    expect(mockAddMutateAsync).toHaveBeenLastCalledWith({
      projectId: 'project-1',
      file_id: 'canonical-file-id',
    });
  });

  it('composes the selected library IDs with the fixed project and keeps unavailable members', async () => {
    mockProjectQueryState.data = [{ file_id: 'gone-id', availability: 'unavailable' }];
    renderResources();
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add files' }));
    await user.click(screen.getByRole('menuitem', { name: 'Choose an existing file' }));
    expect(await screen.findByTestId('membership-action')).toHaveTextContent(
      'project-1:library-file',
    );
    expect(mockLibraryProps).not.toHaveProperty('projectId');
    expect(mockUploadMutateAsync).not.toHaveBeenCalled();
    expect(mockRemoveMutateAsync).not.toHaveBeenCalled();
  });

  it('keeps the library picker available when device upload is denied', async () => {
    mockCanUseFileSearch.mockReturnValue(false);
    renderResources();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add files' }));
    expect(screen.queryByRole('menuitem', { name: 'Upload file' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'Choose an existing file' }));
    expect(await screen.findByTestId('membership-action')).toHaveTextContent(
      'project-1:library-file',
    );
  });

  it('keeps the native add control visible/disabled with its actual German storage reason on focus', async () => {
    mockUploadAdmissionError = 'com_upload_storage_unavailable';
    renderResources();
    expect(screen.getByRole('button', { name: 'Add files' })).toBeDisabled();
    const explanation = screen.getByRole('group', { name: 'Add files' });
    explanation.focus();
    expect(explanation).toHaveFocus();
    fireEvent.keyDown(explanation, { key: 'Enter' });
    await waitFor(() =>
      expect(screen.getByRole('tooltip')).toHaveTextContent(
        mockGerman.com_upload_storage_unavailable,
      ),
    );
    fireEvent.change(screen.getByTestId('project-upload-input'), {
      target: { files: [new File(['x'], 'blocked.txt')] },
    });
    expect(mockUploadMutateAsync).not.toHaveBeenCalled();
    expect(mockAddMutateAsync).not.toHaveBeenCalled();
    expect(screen.queryByText('blocked.txt')).not.toBeInTheDocument();
  });

  it('closes an unknown status and rechecks a stale carrier at the input event before mutation', () => {
    mockUploadAdmissionError = 'com_upload_status_unavailable';
    const view = renderResources();
    expect(screen.getByRole('button', { name: 'Add files' })).toBeDisabled();
    mockUploadAdmissionError = null;
    view.rerender(<ProjectResources project={project} />);
    expect(screen.getByRole('button', { name: 'Add files' })).toBeEnabled();
    mockLiveUploadAdmissionError = 'com_upload_storage_stale';
    fireEvent.change(screen.getByTestId('project-upload-input'), {
      target: { files: [new File(['x'], 'stale.txt')] },
    });
    expect(mockUploadMutateAsync).not.toHaveBeenCalled();
    expect(mockShowToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: mockGerman.com_upload_storage_stale }),
    );
  });

  it('storage recovery preserves manual pause, quota and permission causes', async () => {
    mockUploadAdmissionError = 'com_upload_storage_unavailable';
    const view = renderResources();
    for (const cause of ['com_upload_admission_paused', 'com_upload_quota_exceeded']) {
      mockUploadAdmissionError = cause;
      view.rerender(<ProjectResources project={project} />);
      expect(screen.getByRole('button', { name: 'Add files' })).toBeDisabled();
    }
    mockUploadAdmissionError = null;
    mockCanUseFileSearch.mockReturnValue(false);
    view.rerender(<ProjectResources project={project} />);
    fireEvent.change(screen.getByTestId('project-upload-input'), {
      target: { files: [new File(['x'], 'unauthorized.txt')] },
    });
    expect(mockUploadMutateAsync).not.toHaveBeenCalled();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Add files' }));
    expect(screen.queryByRole('menuitem', { name: 'Upload file' })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Choose an existing file' })).toBeVisible();
  });

  it('rechecks the same live owner before the next queued body while finishing the first association', async () => {
    let finish!: (file: TFileUpload) => void;
    mockUploadMutateAsync.mockReset().mockImplementationOnce(
      () =>
        new Promise<TFileUpload>((resolve) => {
          finish = resolve;
        }),
    );
    renderResources();
    fireEvent.change(screen.getByTestId('project-upload-input'), {
      target: { files: [new File(['a'], 'first.txt'), new File(['b'], 'second.txt')] },
    });
    expect(mockUploadMutateAsync).toHaveBeenCalledTimes(1);
    mockLiveUploadAdmissionError = 'com_upload_storage_unavailable';
    finish(uploadedFile);
    await waitFor(() => expect(mockAddMutateAsync).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(mockGerman.com_upload_storage_unavailable)).toBeVisible();
    expect(mockUploadMutateAsync).toHaveBeenCalledTimes(1);
    expect(screen.getByText('second.txt')).toBeVisible();
  });

  it('guards a byte retry from both disabled UI and a newer live failure without replacing its identity', async () => {
    mockUploadMutateAsync
      .mockReset()
      .mockRejectedValueOnce(new Error('inert upload rejected'))
      .mockResolvedValue(uploadedFile);
    const view = renderResources();
    fireEvent.change(screen.getByTestId('project-upload-input'), {
      target: { files: [new File(['x'], 'retry.txt')] },
    });
    let retry = await screen.findByRole('button', { name: 'Retry' });
    const originalBody = mockUploadMutateAsync.mock.calls[0][0] as FormData;
    mockUploadAdmissionError = 'com_upload_storage_unavailable';
    view.rerender(<ProjectResources project={project} />);
    retry = screen.getByRole('button', { name: 'Retry' });
    expect(retry).toBeDisabled();
    mockUploadAdmissionError = null;
    view.rerender(<ProjectResources project={project} />);
    mockLiveUploadAdmissionError = 'com_upload_storage_stale';
    retry = screen.getByRole('button', { name: 'Retry' });
    fireEvent.click(retry);
    expect(mockUploadMutateAsync).toHaveBeenCalledTimes(1);
    mockLiveUploadAdmissionError = null;
    fireEvent.click(retry);
    await waitFor(() => expect(mockUploadMutateAsync).toHaveBeenCalledTimes(2));
    expect((mockUploadMutateAsync.mock.calls[1][0] as FormData).get('file_id')).toBe(
      originalBody.get('file_id'),
    );
  });

  it('keeps an association-only retry and reference cleanup available without another byte upload', async () => {
    mockUploadMutateAsync.mockReset().mockResolvedValue(uploadedFile);
    mockAddMutateAsync
      .mockRejectedValueOnce(new Error('inert association rejected'))
      .mockResolvedValue({});
    const view = renderResources();
    fireEvent.change(screen.getByTestId('project-upload-input'), {
      target: { files: [new File(['x'], 'owned.txt')] },
    });
    const retry = await screen.findByRole('button', { name: 'Retry' });
    mockUploadAdmissionError = 'com_upload_storage_unavailable';
    view.rerender(<ProjectResources project={project} />);
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    await waitFor(() => expect(mockAddMutateAsync).toHaveBeenCalledTimes(2));
    expect(mockUploadMutateAsync).toHaveBeenCalledTimes(1);
  });

  it('never continues a selected body or association under a replacement principal', async () => {
    let finish!: (file: TFileUpload) => void;
    mockUploadMutateAsync.mockReset().mockImplementationOnce(
      () =>
        new Promise<TFileUpload>((resolve) => {
          finish = resolve;
        }),
    );
    const view = renderResources();
    fireEvent.change(screen.getByTestId('project-upload-input'), {
      target: { files: [new File(['a'], 'original.txt'), new File(['b'], 'queued.txt')] },
    });
    expect(mockUploadMutateAsync).toHaveBeenCalledTimes(1);
    mockUploadSessionKey = 'tenant/replacement';
    view.rerender(<ProjectResources project={project} />);
    finish(uploadedFile);
    await waitFor(() => expect(screen.queryByText('Processing')).not.toBeInTheDocument());
    expect(mockUploadMutateAsync).toHaveBeenCalledTimes(1);
    expect(mockAddMutateAsync).not.toHaveBeenCalled();
    expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(2);
    for (const retry of screen.getAllByRole('button', { name: 'Retry' }))
      expect(retry).toBeDisabled();
  });
});
