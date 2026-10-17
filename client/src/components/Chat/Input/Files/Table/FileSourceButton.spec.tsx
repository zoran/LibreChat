import userEvent from '@testing-library/user-event';
import { FileSources } from 'librechat-data-provider';
import { render, screen, waitFor } from '@testing-library/react';
import { OGDialog, OGDialogContent, OGDialogTitle } from '@librechat/client';
import type { TFile } from 'librechat-data-provider';
import FileSourceButton from './FileSourceButton';

const mockPreview = jest.fn();
const mockBlob = jest.fn();
jest.mock('recoil', () => ({ useRecoilValue: () => ({ id: 'owner' }) }));
jest.mock('~/store', () => ({ user: {} }));
jest.mock('~/Providers', () => ({
  useShareContext: () => ({}),
  useFileMapContext: () => ({}),
}));
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: { 0: string }) =>
    values ? `${key}: ${values[0]}` : key,
}));
jest.mock('~/utils', () => ({
  getDownloadFilename: (name: string) => name,
  logger: { error: jest.fn() },
  sortPagesByRelevance: () => [],
  triggerDownload: jest.fn(),
}));
jest.mock('~/data-provider', () => ({
  useFilePreview: (...args: unknown[]) => {
    mockPreview(...args);
    return {
      data: { file_id: args[0], status: 'ready', text: 'Approved native text' },
      isFetching: false,
    };
  },
  useFileDownload: () => ({ refetch: jest.fn() }),
  useSharedFileDownload: () => ({ refetch: jest.fn() }),
  useFilePreviewBlob: (...args: unknown[]) => {
    mockBlob(...args);
    return { refetch: jest.fn().mockResolvedValue({}) };
  },
}));
jest.mock('~/components/Messages/Content/CopyButton', () => () => null);

const file: TFile = {
  file_id: 'native-approved-id',
  filename: 'Original.txt',
  type: 'text/plain',
  source: FileSources.local,
  bytes: 2048,
  llmDeliveryPath: 'text',
  filepath: '/private/path-must-not-be-used',
  user: 'owner',
  embedded: false,
  object: 'file',
  usage: 0,
};

describe('FileSourceButton', () => {
  it('opens the native preview by keyboard and restores focus to the filename on Escape', async () => {
    const user = userEvent.setup();
    render(
      <OGDialog open>
        <OGDialogContent>
          <OGDialogTitle>{'com_nav_my_files'}</OGDialogTitle>
          <FileSourceButton file={file} />
        </OGDialogContent>
      </OGDialog>,
    );
    const button = screen.getByRole('button', {
      name: 'com_ui_composer_preview_file: Original.txt',
    });
    expect(button).toHaveAttribute('aria-haspopup', 'dialog');
    button.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('dialog', { name: file.filename })).toBeInTheDocument();
    expect(screen.getByText('Approved native text')).toBeInTheDocument();
    expect(screen.getByText('PLAIN · 2.0 KB')).toBeInTheDocument();
    expect(mockPreview).toHaveBeenLastCalledWith(file.file_id, { enabled: true }, undefined);
    expect(mockBlob).toHaveBeenLastCalledWith('owner', file.file_id, undefined);
    expect(document.body.innerHTML).not.toContain(file.filepath);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(button).toHaveFocus());
    expect(screen.queryByRole('dialog', { name: file.filename })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'com_nav_my_files' })).toBeInTheDocument();
  });

  it('opens the same preview for an image filename without deriving a raw source URL', async () => {
    const user = userEvent.setup();
    render(
      <FileSourceButton
        file={{ ...file, filename: 'image.png', type: 'image/png', llmDeliveryPath: undefined }}
      />,
    );
    await user.click(
      screen.getByRole('button', { name: 'com_ui_composer_preview_file: image.png' }),
    );
    expect(await screen.findByRole('dialog', { name: 'image.png' })).toBeInTheDocument();
    expect(mockBlob).toHaveBeenLastCalledWith('owner', file.file_id, undefined);
    expect(document.body.innerHTML).not.toContain(file.filepath);
  });
});
