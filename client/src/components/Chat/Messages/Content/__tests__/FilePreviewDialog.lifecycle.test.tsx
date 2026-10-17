import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TFilePreview } from 'librechat-data-provider';
import FilePreviewDialog from '../FilePreviewDialog';

let mockFileMap: Record<string, { llmDeliveryPath: 'text' }> = {};
let mockShareId: string | undefined;
let mockPreview: TFilePreview | undefined;
let mockPreviewError = false;
let mockPreviewFetching = false;
const mockOwnedPreview = jest.fn();
const mockSharedPreview = jest.fn();
const mockDownload = jest.fn();
const mockRetry = jest.fn();
const mockRevoke = jest.fn();
const mockTriggerDownload = jest.fn();
const mockUseFilePreview = jest.fn();
const mockSourceView = jest.fn();

jest.mock('../DocumentSourceView', () => ({
  __esModule: true,
  default: (props: { text: string }) => {
    mockSourceView(props);
    return <section aria-label="validated source">{props.text}</section>;
  },
}));

jest.mock('recoil', () => ({ useRecoilValue: () => ({ id: 'owner' }) }));
jest.mock('~/store', () => ({ user: {} }));
jest.mock('~/Providers', () => ({
  useShareContext: () => ({ shareId: mockShareId }),
  useFileMapContext: () => mockFileMap,
}));
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('~/utils', () => ({
  getDownloadFilename: (name: string) => name,
  logger: { error: jest.fn() },
  sortPagesByRelevance: () => [],
  triggerDownload: (...args: unknown[]) => mockTriggerDownload(...args),
}));
jest.mock('~/data-provider', () => ({
  useFilePreview: (...args: unknown[]) => {
    mockUseFilePreview(...args);
    return {
      data: mockPreview,
      isInitialLoading: !mockPreview && !mockPreviewError,
      isFetching: mockPreviewFetching,
      isError: mockPreviewError,
      refetch: mockRetry,
    };
  },
  useFileDownload: (_user: string, _file: string, options: { purpose?: string }) => ({
    refetch: options.purpose === 'preview' ? mockOwnedPreview : mockDownload,
  }),
  useFilePreviewBlob: (_user: string, _file: string, shareId?: string) => ({
    refetch: shareId ? mockSharedPreview : mockOwnedPreview,
  }),
  useSharedFileDownload: (_share: string, _file: string, purpose?: string) => ({
    refetch: purpose === 'preview' ? mockSharedPreview : mockDownload,
  }),
  revokeDownloadURL: (url: string) => mockRevoke(url),
}));
jest.mock('@librechat/client', () => ({
  OGDialog: ({ open, children }: React.PropsWithChildren<{ open: boolean }>) =>
    open ? <div>{children}</div> : null,
  OGDialogContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  OGDialogTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
  OGDialogDescription: ({ children }: React.PropsWithChildren) => <p>{children}</p>,
  Button: ({ children, onClick }: React.PropsWithChildren<{ onClick: () => void }>) => (
    <button onClick={onClick}>{children}</button>
  ),
}));
jest.mock('~/components/Messages/Content/CopyButton', () => () => null);

const props = {
  open: true,
  onOpenChange: jest.fn(),
  fileId: 'f1',
  fileName: 'report.pdf',
  fileType: 'application/pdf',
};

describe('FilePreviewDialog lifecycle', () => {
  it('renders an ordinary PDF and revokes its display URL on close', async () => {
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    const revoke = jest.fn();
    URL.createObjectURL = jest.fn(() => 'blob:display');
    URL.revokeObjectURL = revoke;
    try {
      mockOwnedPreview.mockResolvedValue({ data: new Blob(['pdf']) });
      const view = render(<FilePreviewDialog {...props} />);
      await waitFor(() =>
        expect(screen.getByTitle('com_ui_preview: report.pdf')).toHaveAttribute(
          'src',
          'blob:display',
        ),
      );
      view.unmount();
      expect(revoke).toHaveBeenCalledWith('blob:display');
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockFileMap = {};
    mockShareId = undefined;
    mockPreview = { file_id: 'f1', status: 'ready', text: 'extracted document' };
    mockPreviewError = false;
    mockPreviewFetching = false;
    mockOwnedPreview.mockResolvedValue({});
    mockSharedPreview.mockResolvedValue({});
    mockDownload.mockResolvedValue({ data: 'blob:original' });
  });

  it('renders extracted text and downloads the original object', async () => {
    render(<FilePreviewDialog {...props} deliveryPath="text" />);
    expect(screen.getByText('extracted document')).toBeInTheDocument();
    expect(mockOwnedPreview).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_download report.pdf' }));
    await waitFor(() =>
      expect(mockTriggerDownload).toHaveBeenCalledWith('blob:original', 'report.pdf'),
    );
  });

  it('handles pending, polling failure, retry, and empty success', () => {
    mockPreview = { file_id: 'f1', status: 'pending' };
    const view = render(<FilePreviewDialog {...props} deliveryPath="text" />);
    expect(screen.getByText('com_ui_loading')).toBeInTheDocument();
    mockPreviewError = true;
    view.rerender(<FilePreviewDialog {...props} deliveryPath="text" />);
    expect(screen.queryByText('com_ui_loading')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));
    expect(mockRetry).toHaveBeenCalledTimes(1);
    mockPreviewError = false;
    mockPreview = { file_id: 'f1', status: 'ready', text: '' };
    view.rerender(<FilePreviewDialog {...props} deliveryPath="text" />);
    expect(screen.queryByText('com_ui_preview_unavailable')).toBeNull();
  });

  it('recovers late metadata while open and discards the obsolete binary response', async () => {
    let resolve!: (value: { data: Blob }) => void;
    mockOwnedPreview.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const view = render(<FilePreviewDialog {...props} />);
    mockFileMap = { f1: { llmDeliveryPath: 'text' } };
    view.rerender(<FilePreviewDialog {...props} />);
    expect(screen.getByText('extracted document')).toBeInTheDocument();
    await act(async () => {
      resolve({ data: new Blob(['obsolete']) });
    });
    expect(screen.queryByTitle('com_ui_preview: report.pdf')).toBeNull();
  });

  it('handles a deduplicated response after closing and reopening', async () => {
    let resolve!: (value: { data: Blob }) => void;
    mockOwnedPreview.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const textProps = { ...props, fileName: 'notes.txt', fileType: 'text/plain' };
    const view = render(<FilePreviewDialog {...textProps} />);
    view.rerender(<FilePreviewDialog {...textProps} open={false} />);
    view.rerender(<FilePreviewDialog {...textProps} />);
    expect(mockOwnedPreview).toHaveBeenCalledTimes(2);
    await act(async () => {
      resolve({ data: { text: async () => 'shared bytes' } as Blob });
    });
    expect(screen.getByText('shared bytes')).toBeInTheDocument();
    expect(screen.queryByText('com_ui_preview_unavailable')).toBeNull();
  });

  it('uses only shared metadata and the shared authorization scope', async () => {
    mockShareId = 'public-share';
    mockFileMap = { f1: { llmDeliveryPath: 'text' } };
    const view = render(<FilePreviewDialog {...props} />);
    await waitFor(() => expect(mockSharedPreview).toHaveBeenCalledTimes(1));
    expect(mockOwnedPreview).not.toHaveBeenCalled();
    expect(screen.queryByText('extracted document')).toBeNull();
    view.rerender(<FilePreviewDialog {...props} deliveryPath="text" />);
    expect(mockUseFilePreview).toHaveBeenLastCalledWith('f1', { enabled: true }, 'public-share');
    expect(screen.getByText('extracted document')).toBeInTheDocument();
  });

  it('hides cached source text during revalidation and after a revoked-access response', () => {
    const view = render(<FilePreviewDialog {...props} deliveryPath="text" />);
    expect(screen.getByText('extracted document')).toBeInTheDocument();
    mockPreviewFetching = true;
    view.rerender(<FilePreviewDialog {...props} deliveryPath="text" />);
    expect(screen.queryByText('extracted document')).toBeNull();
    expect(screen.getByText('com_ui_loading')).toBeInTheDocument();
    mockPreviewFetching = false;
    mockPreviewError = true;
    view.rerender(<FilePreviewDialog {...props} deliveryPath="text" />);
    expect(screen.queryByText('extracted document')).toBeNull();
    expect(screen.getByText('com_ui_preview_unavailable')).toBeInTheDocument();
  });

  it('never presents a preview belonging to a different file', () => {
    mockPreview = { file_id: 'other', status: 'ready', text: 'another source' };
    render(<FilePreviewDialog {...props} deliveryPath="text" />);
    expect(screen.queryByText('another source')).toBeNull();
    expect(screen.getByText('com_ui_preview_unavailable')).toBeInTheDocument();
  });

  function structuredPreview(): TFilePreview {
    return {
      file_id: 'f1',
      status: 'ready',
      text: 'Source text',
      textFormat: 'text',
      documentStructure: {
        version: 1,
        source: { sha256: 'a'.repeat(64), bytes: 128, mediaType: 'application/pdf' },
        extractor: { name: 'synthetic-test', version: '1' },
        pages: [{ number: 1, kind: 'page' }],
        elements: [{ id: 'e1', kind: 'paragraph', start: 0, end: 11, page: 1, parentId: null }],
        quality: { status: 'partial', warnings: ['layout_unavailable'] },
      },
    };
  }

  it('passes only validated native source ranges and citation selection to the source view', () => {
    mockPreview = structuredPreview();
    render(<FilePreviewDialog {...props} deliveryPath="text" pages={[1]} sourceElementId="e1" />);
    expect(screen.getByRole('region', { name: 'validated source' })).toHaveTextContent(
      'Source text',
    );
    expect(mockSourceView).toHaveBeenLastCalledWith({
      text: 'Source text',
      structure: mockPreview.documentStructure,
      initialPage: 1,
      initialElementId: 'e1',
    });
    expect(mockOwnedPreview).not.toHaveBeenCalled();
  });

  it('rejects malformed present structure instead of showing unverified source positions', () => {
    mockPreview = structuredPreview();
    mockPreview.documentStructure!.elements[0].end = 100;
    render(<FilePreviewDialog {...props} deliveryPath="text" />);
    expect(screen.queryByText('Source text')).toBeNull();
    expect(mockSourceView).not.toHaveBeenCalled();
    expect(screen.getByText('com_ui_preview_unavailable')).toBeInTheDocument();
  });

  it('refuses cached binary data when reopening returns a failed revalidation', async () => {
    const blob = { text: async () => 'cached private text' } as Blob;
    mockOwnedPreview.mockResolvedValue({ data: blob, isError: false });
    const textProps = { ...props, fileName: 'notes.txt', fileType: 'text/plain' };
    const view = render(<FilePreviewDialog {...textProps} />);
    await waitFor(() => expect(screen.getByText('cached private text')).toBeInTheDocument());
    view.rerender(<FilePreviewDialog {...textProps} open={false} />);
    mockOwnedPreview.mockResolvedValue({ data: blob, isError: true });
    view.rerender(<FilePreviewDialog {...textProps} />);
    await waitFor(() => expect(screen.getByText('com_ui_preview_unavailable')).toBeInTheDocument());
    expect(screen.queryByText('cached private text')).toBeNull();
  });

  it('refuses a cached download URL retained after authorization failure', async () => {
    render(<FilePreviewDialog {...props} deliveryPath="text" />);
    const download = screen.getByRole('button', { name: 'com_ui_download report.pdf' });
    fireEvent.click(download);
    await waitFor(() => expect(mockTriggerDownload).toHaveBeenCalledTimes(1));
    mockDownload.mockResolvedValue({ data: 'blob:original', isError: true });
    fireEvent.click(download);
    await waitFor(() => expect(mockDownload).toHaveBeenCalledTimes(2));
    expect(mockTriggerDownload).toHaveBeenCalledTimes(1);
  });
});
