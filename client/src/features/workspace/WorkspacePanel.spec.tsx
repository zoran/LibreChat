import * as mockReact from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DocumentWorkspace } from 'librechat-data-provider';
import mockGerman from '~/locales/de/translation.json';
import {
  createWorkspace,
  listWorkspaces,
  loadWorkspace,
  loadWorkspaceRevision,
  saveWorkspace,
} from './api';
import { WorkspacePanel } from './WorkspacePanel';
import type { WorkspaceEditorProps } from './WorkspaceEditor';

jest.mock('./api', () => ({
  createWorkspace: jest.fn(),
  listWorkspaces: jest.fn(),
  loadWorkspace: jest.fn(),
  loadWorkspaceRevision: jest.fn(),
  saveWorkspace: jest.fn(),
}));
jest.mock('~/hooks/useLocalize', () => ({
  __esModule: true,
  default: () => (key: string) => (mockGerman as Record<string, string>)[key] ?? key,
}));
let mockDisposed = 0;
let mockEditorProps: WorkspaceEditorProps | null = null;
/** The editor double keeps local state; API and real Monaco each have their own owner coverage. */
jest.mock('./WorkspaceEditor', () => ({
  WorkspaceEditor: function EditorPort(props: WorkspaceEditorProps) {
    mockEditorProps = props;
    const { identity, initial, onSave } = props;
    const [value, setValue] = mockReact.useState(() => new TextDecoder().decode(initial.bytes));
    const [error, setError] = mockReact.useState('');
    mockReact.useEffect(() => {
      setValue(new TextDecoder().decode(initial.bytes));
      return () => {
        mockDisposed++;
      };
    }, [identity.workspaceId]);
    return (
      <div>
        <textarea
          aria-label="Testentwurf"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <button
          type="button"
          onClick={() =>
            void onSave(
              {
                identity,
                phase: 'reserve',
                idempotencyKey: '471dc724-88d2-4b3a-88dc-1f67490bc4a4',
                baseRevision: initial.workspace.revision,
                bytes: new TextEncoder().encode(value),
              },
              () => undefined,
            ).catch(() => setError('Testfehler'))
          }
        >
          {'Testspeichern'}
        </button>
        {error && <p>{error}</p>}
      </div>
    );
  },
}));

const owner = { ownerId: 'owner', tenantId: null };
const item = (id: string): DocumentWorkspace => ({
  workspaceId: id,
  title: `Entwurf ${id}`,
  format: 'markdown',
  revision: 0,
  headFileId: null,
  createdAt: '2026-10-17T00:00:00Z',
  updatedAt: '2026-10-17T00:00:00Z',
  expiresAt: null,
});
const document = (id: string) => ({
  workspace: item(id),
  bytes: new TextEncoder().encode(`Text ${id}`),
});
function pending<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

describe('private workspace panel ownership and draft preservation', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockDisposed = 0;
    mockEditorProps = null;
    (listWorkspaces as jest.Mock).mockResolvedValue({
      workspaces: [item('a'), item('b')],
      nextCursor: null,
    });
    (loadWorkspace as jest.Mock).mockImplementation(async (id) => document(id));
    (createWorkspace as jest.Mock).mockResolvedValue(item('new'));
    (saveWorkspace as jest.Mock).mockImplementation(async (attempt) => ({
      version: {
        workspaceId: 'a',
        revision: attempt.baseRevision + 1,
        fileId: 'file',
        createdAt: item('a').createdAt,
        expiresAt: '2026-11-14T00:00:00Z',
      },
      bytes: attempt.bytes,
    }));
  });

  it('keeps local edits while returning to the overview and confirms a different document before loading', async () => {
    const view = render(<WorkspacePanel owner={owner} enabled />);
    fireEvent.click(await screen.findByRole('button', { name: 'Entwurf a' }));
    const editor = await screen.findByRole('textbox', { name: 'Testentwurf' });
    fireEvent.change(editor, { target: { value: 'Noch nicht gespeichert' } });
    fireEvent.click(screen.getByRole('button', { name: 'Zur Übersicht' }));
    expect(editor).toHaveValue('Noch nicht gespeichert');
    expect(editor).not.toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Entwurf b' }));
    expect(loadWorkspace).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Beim bisherigen Entwurf bleiben' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Beim bisherigen Entwurf bleiben' }));
    expect(editor).toBeVisible();
    expect(editor).toHaveValue('Noch nicht gespeichert');
    fireEvent.click(screen.getByRole('button', { name: 'Zur Übersicht' }));
    const next = pending<ReturnType<typeof document>>();
    (loadWorkspace as jest.Mock).mockReturnValueOnce(next.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Entwurf b' }));
    fireEvent.click(screen.getByRole('button', { name: 'Entwurf schließen und wechseln' }));
    expect(
      screen.getByRole('button', { name: 'Geöffneten Entwurf weiterbearbeiten' }),
    ).toBeDisabled();
    expect(editor).not.toBeVisible();
    await act(async () => next.resolve(document('b')));
    expect(loadWorkspace).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole('textbox', { name: 'Testentwurf' })).toHaveValue('Text b');
    view.unmount();
  });

  it('lists more entries without replacing the opened editor and creates revision zero without saving', async () => {
    (listWorkspaces as jest.Mock)
      .mockResolvedValueOnce({ workspaces: [item('a')], nextCursor: 'next' })
      .mockResolvedValueOnce({ workspaces: [item('a'), item('b')], nextCursor: null });
    const view = render(<WorkspacePanel owner={owner} enabled />);
    fireEvent.click(await screen.findByRole('button', { name: 'Weitere Entwürfe laden' }));
    await screen.findByRole('button', { name: 'Entwurf b' });
    expect(screen.getAllByRole('button', { name: 'Entwurf a' })).toHaveLength(1);
    expect(listWorkspaces).toHaveBeenLastCalledWith(expect.any(AbortSignal), 'next');
    fireEvent.click(screen.getByRole('button', { name: 'Neuen Entwurf erstellen' }));
    expect(await screen.findByRole('textbox', { name: 'Testentwurf' })).toHaveValue('');
    expect(createWorkspace).toHaveBeenCalledWith('markdown', expect.any(AbortSignal));
    expect(saveWorkspace).not.toHaveBeenCalled();
    view.unmount();
  });

  it('refreshes current metadata independently of a historical save receipt', async () => {
    (listWorkspaces as jest.Mock)
      .mockResolvedValueOnce({ workspaces: [item('a')], nextCursor: null })
      .mockResolvedValueOnce({
        workspaces: [{ ...item('a'), revision: 3, headFileId: 'newer-head' }],
        nextCursor: null,
      });
    const view = render(<WorkspacePanel owner={owner} enabled />);
    fireEvent.click(await screen.findByRole('button', { name: 'Entwurf a' }));
    const text = await screen.findByRole('textbox', { name: 'Testentwurf' });
    fireEvent.change(text, { target: { value: 'My current local text' } });
    fireEvent.click(screen.getByRole('button', { name: 'Testspeichern' }));
    await waitFor(() => expect(listWorkspaces).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'Zur Übersicht' }));
    expect(await screen.findByText(/3 ·/)).toBeVisible();
    expect(text).toHaveValue('My current local text');
    expect(loadWorkspace).toHaveBeenCalledTimes(1);
    expect(mockDisposed).toBe(0);
    view.unmount();
  });

  it('aborts and ignores an old list after ownership changes', async () => {
    const old = pending<{ workspaces: DocumentWorkspace[]; nextCursor: null }>();
    (listWorkspaces as jest.Mock)
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce({ workspaces: [item('new-owner')], nextCursor: null });
    const view = render(<WorkspacePanel owner={owner} enabled />);
    const oldSignal = (listWorkspaces as jest.Mock).mock.calls[0][0] as AbortSignal;
    view.rerender(<WorkspacePanel owner={{ ownerId: 'other', tenantId: null }} enabled />);
    await screen.findByRole('button', { name: 'Entwurf new-owner' });
    await act(async () => old.resolve({ workspaces: [item('private-old')], nextCursor: null }));
    expect(oldSignal.aborted).toBe(true);
    expect(screen.queryByText('Entwurf private-old')).not.toBeInTheDocument();
    view.unmount();
  });

  it('disposes the old editor on owner switch and ignores its late save result', async () => {
    const save = pending<ReturnType<typeof document>>();
    (saveWorkspace as jest.Mock).mockReturnValueOnce(save.promise);
    const view = render(<WorkspacePanel owner={owner} enabled />);
    fireEvent.click(await screen.findByRole('button', { name: 'Entwurf a' }));
    await screen.findByRole('textbox', { name: 'Testentwurf' });
    fireEvent.click(screen.getByRole('button', { name: 'Testspeichern' }));
    const signal = (saveWorkspace as jest.Mock).mock.calls[0][1] as AbortSignal;
    view.rerender(<WorkspacePanel owner={{ ownerId: 'other', tenantId: null }} enabled />);
    await act(async () => save.resolve(document('private-old')));
    expect(signal.aborted).toBe(true);
    expect(mockDisposed).toBe(1);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByText('Entwurf private-old')).not.toBeInTheDocument();
    view.unmount();
  });

  it.each(['source_unavailable', 'auth-event'])('clears all private state for %s', async (kind) => {
    const view = render(<WorkspacePanel owner={owner} enabled />);
    fireEvent.click(await screen.findByRole('button', { name: 'Entwurf a' }));
    await screen.findByRole('textbox', { name: 'Testentwurf' });
    if (kind === 'auth-event')
      act(() => window.dispatchEvent(new Event('librechat:auth-session-ending')));
    else {
      (saveWorkspace as jest.Mock).mockRejectedValueOnce({ code: 'source_unavailable' });
      fireEvent.click(screen.getByRole('button', { name: 'Testspeichern' }));
    }
    await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument());
    expect(screen.queryByText('Entwurf a')).not.toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('Zugriff');
    view.unmount();
  });

  it('keeps a failed save editable and explains unsupported empty content', async () => {
    (saveWorkspace as jest.Mock).mockRejectedValueOnce({ code: 'empty_document' });
    const view = render(<WorkspacePanel owner={owner} enabled />);
    fireEvent.click(await screen.findByRole('button', { name: 'Entwurf a' }));
    const editor = await screen.findByRole('textbox', { name: 'Testentwurf' });
    fireEvent.change(editor, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Testspeichern' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('vollständig leerer Text');
    expect(editor).toHaveValue('');
    view.unmount();
  });

  it('composes an explicit historical read without changing the document and preserves edits on404', async () => {
    const view = render(<WorkspacePanel owner={owner} enabled />);
    fireEvent.click(await screen.findByRole('button', { name: 'Entwurf a' }));
    const text = await screen.findByRole('textbox', { name: 'Testentwurf' });
    fireEvent.change(text, { target: { value: 'Lokale Arbeit' } });
    (loadWorkspaceRevision as jest.Mock)
      .mockResolvedValueOnce({
        workspaceId: 'a',
        revision: 1,
        bytes: new TextEncoder().encode('Alt'),
      })
      .mockRejectedValueOnce({ code: 'not_found', status: 404 });
    const signal = new AbortController().signal;
    await expect(mockEditorProps!.onReadRevision(1, signal)).resolves.toMatchObject({
      workspaceId: 'a',
      revision: 1,
    });
    expect(loadWorkspaceRevision).toHaveBeenCalledWith('a', 1, expect.any(AbortSignal));
    await expect(mockEditorProps!.onReadRevision(1, signal)).rejects.toMatchObject({ status: 404 });
    expect(text).toHaveValue('Lokale Arbeit');
    expect(mockDisposed).toBe(0);
    expect(saveWorkspace).not.toHaveBeenCalled();
    expect(loadWorkspace).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it.each(['owner', 'caller', 'session'])(
    'aborts the historical read on %s cancellation and rejects a late response',
    async (kind) => {
      const request = pending<{ workspaceId: string; revision: number; bytes: Uint8Array }>();
      (loadWorkspaceRevision as jest.Mock).mockReturnValueOnce(request.promise);
      const view = render(<WorkspacePanel owner={owner} enabled />);
      fireEvent.click(await screen.findByRole('button', { name: 'Entwurf a' }));
      await screen.findByRole('textbox', { name: 'Testentwurf' });
      const caller = new AbortController();
      const result = mockEditorProps!
        .onReadRevision(1, caller.signal)
        .catch((error: unknown) => error);
      const signal = (loadWorkspaceRevision as jest.Mock).mock.calls[0][2] as AbortSignal;
      if (kind === 'owner')
        view.rerender(<WorkspacePanel owner={{ ...owner, ownerId: 'other' }} enabled />);
      else if (kind === 'session')
        act(() => window.dispatchEvent(new Event('librechat:auth-session-ending')));
      else caller.abort();
      expect(signal.aborted).toBe(true);
      await act(async () =>
        request.resolve({
          workspaceId: 'a',
          revision: 1,
          bytes: new TextEncoder().encode('Private alte Antwort'),
        }),
      );
      expect(await result).toMatchObject({ name: 'AbortError' });
      expect(screen.queryByDisplayValue('Private alte Antwort')).not.toBeInTheDocument();
      view.unmount();
    },
  );

  it.each([401, 403])(
    'invalidates the private panel when the historical read returns%s',
    async (status) => {
      (loadWorkspaceRevision as jest.Mock).mockRejectedValueOnce({
        code: 'source_unavailable',
        status,
      });
      const view = render(<WorkspacePanel owner={owner} enabled />);
      fireEvent.click(await screen.findByRole('button', { name: 'Entwurf a' }));
      await screen.findByRole('textbox', { name: 'Testentwurf' });
      await act(async () => {
        await expect(
          mockEditorProps!.onReadRevision(1, new AbortController().signal),
        ).rejects.toMatchObject({ status });
      });
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
      expect(screen.queryByText('Entwurf a')).not.toBeInTheDocument();
      expect(mockDisposed).toBe(1);
      view.unmount();
    },
  );

  it('clears disabled panels and survives React strict effect replay without a stale response', async () => {
    const stale = pending<{ workspaces: DocumentWorkspace[]; nextCursor: null }>();
    (listWorkspaces as jest.Mock)
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce({ workspaces: [item('current')], nextCursor: null });
    const view = render(
      <mockReact.StrictMode>
        <WorkspacePanel owner={owner} enabled />
      </mockReact.StrictMode>,
    );
    await screen.findByRole('button', { name: 'Entwurf current' });
    await act(async () => stale.resolve({ workspaces: [item('stale')], nextCursor: null }));
    expect(screen.queryByText('Entwurf stale')).not.toBeInTheDocument();
    view.rerender(<WorkspacePanel owner={owner} enabled={false} />);
    expect(view.container).toBeEmptyDOMElement();
    view.unmount();
  });
});
