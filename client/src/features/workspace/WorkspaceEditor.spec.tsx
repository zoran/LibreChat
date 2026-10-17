import * as mockReact from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DocumentWorkspace } from 'librechat-data-provider';
import mockGerman from '~/locales/de/translation.json';
import { WorkspaceEditor } from './WorkspaceEditor';
import type { WorkspaceEditorDocument, WorkspaceEditorProps } from './WorkspaceEditor';

let mockModelNumber = 0;
const mockModels = new Map<string, ReturnType<typeof mockCreateModel>>();
function mockCreateModel(initial: string, _language: string, uri: { toString(): string }) {
  let text = initial.replace(/^\uFEFF/, '');
  let version = 1;
  let disposed = false;
  const listeners = new Set<() => void>();
  const model = {
    id: `model-${++mockModelNumber}`,
    getValue: () => text,
    getVersionId: () => version,
    isDisposed: () => disposed,
    dispose: jest.fn(() => {
      disposed = true;
      listeners.clear();
      mockModels.delete(uri.toString());
    }),
    onDidChangeContent: (listener: () => void) => {
      listeners.add(listener);
      return {
        dispose: () => {
          listeners.delete(listener);
        },
      };
    },
    edit: (value: string) => {
      text = value;
      version += 1;
      listeners.forEach((listener) => listener());
    },
  };
  mockModels.set(uri.toString(), model);
  return model;
}
const mockMonaco = {
  Uri: { parse: (value: string) => ({ toString: () => value }) },
  editor: {
    getModel: (uri: { toString(): string }) => mockModels.get(uri.toString()) ?? null,
    createModel: mockCreateModel,
  },
};
const mockInitialize = jest.fn(() => Promise.resolve(mockMonaco));
jest.mock('@monaco-editor/react', () => ({ loader: { init: () => mockInitialize() } }));
jest.mock('@librechat/client', () => ({
  ThemeContext: mockReact.createContext({ resolvedMode: 'light', highContrast: false }),
  useRemScale: () => 1,
}));
jest.mock('~/hooks/useLocalize', () => ({
  __esModule: true,
  default: () => (key: string) => (mockGerman as Record<string, string>)[key] ?? key,
}));
/** A textarea stands in for the native editor. The production codec/model adapter still runs. */
jest.mock('~/components/Artifacts/monaco', () => ({
  __esModule: true,
  default: function MonacoPortEditor({
    path,
    options,
  }: {
    path: string;
    options: { readOnly: boolean; ariaLabel: string };
  }) {
    const model = mockModels.get(path)!;
    const [value, setValue] = mockReact.useState(model.getValue());
    mockReact.useEffect(() => {
      const subscription = model.onDidChangeContent(() => setValue(model.getValue()));
      return () => subscription.dispose();
    }, [model]);
    return (
      <textarea
        aria-label={options.ariaLabel}
        readOnly={options.readOnly}
        value={value}
        onChange={(event) => model.edit(event.target.value)}
      />
    );
  },
}));

const bytes = (text: string) => new TextEncoder().encode(text);
const workspace: DocumentWorkspace = {
  workspaceId: 'workspace',
  title: 'Technischer Entwurf',
  format: 'markdown',
  revision: 0,
  headFileId: null,
  createdAt: '2026-10-17T00:00:00Z',
  updatedAt: '2026-10-17T00:00:00Z',
  expiresAt: null,
};
const document = (text: string, revision = 0): WorkspaceEditorDocument => ({
  workspace: { ...workspace, revision, headFileId: revision ? `file-${revision}` : null },
  bytes: bytes(text),
});
function props(initial = document('Original\r\n')): WorkspaceEditorProps {
  return {
    identity: { tenantId: 'tenant', ownerId: 'owner', workspaceId: 'workspace' },
    initial,
    onSave: jest.fn(async ({ baseRevision, bytes: saved }) => ({
      workspace: {
        ...workspace,
        revision: baseRevision + 1,
        headFileId: `file-${baseRevision + 1}`,
      },
      bytes: saved,
    })),
    onReload: jest.fn(async () => document('Server\n', 1)),
  };
}
function pending<T>() {
  let resolve!: (value: T) => void;
  let reject!: (value: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const saveButton = () => screen.getByRole('button', { name: 'Speichern' });
const editor = () => screen.findByRole('textbox', { name: 'Dokumenttext' });

describe('workspace editor view with real codec and model adapter', () => {
  beforeEach(() => mockInitialize.mockImplementation(() => Promise.resolve(mockMonaco)));
  afterEach(() => {
    if (mockModels.size !== 0) throw new Error('The test left an editor model alive');
  });

  it('opens without upload or browser persistence and saves only edited exact bytes', async () => {
    const input = props(document('\uFEFFOriginal\r\n'));
    const store = jest.spyOn(Storage.prototype, 'setItem');
    const view = render(<WorkspaceEditor {...input} />);
    const text = await editor();
    expect(saveButton()).toBeDisabled();
    fireEvent.keyDown(text, { key: 's', ctrlKey: true });
    expect(input.onSave).not.toHaveBeenCalled();
    fireEvent.change(text, { target: { value: 'Geändert\n' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Gespeichert'));
    expect(input.onSave).toHaveBeenCalledWith({
      baseRevision: 0,
      bytes: bytes('\uFEFFGeändert\r\n'),
    });
    expect(saveButton()).toBeDisabled();
    expect(store).not.toHaveBeenCalled();
    view.unmount();
  });

  it.each(['ctrlKey', 'metaKey'])(
    'saves with %s+S and guards duplicate requests while preserving newer edits',
    async (modifier) => {
      const request = pending<WorkspaceEditorDocument>();
      const input = props();
      input.onSave = jest.fn(() => request.promise);
      const view = render(<WorkspaceEditor {...input} />);
      const text = await editor();
      fireEvent.change(text, { target: { value: 'Zwischenstand\n' } });
      fireEvent.keyDown(text, { key: 's', [modifier]: true });
      fireEvent.keyDown(text, { key: 's', [modifier]: true });
      fireEvent.change(text, { target: { value: 'Neuere lokale Änderung\n' } });
      expect(input.onSave).toHaveBeenCalledTimes(1);
      expect(text).not.toHaveAttribute('readonly');
      await act(async () => request.resolve(document('Zwischenstand\r\n', 1)));
      expect(text).toHaveValue('Neuere lokale Änderung\n');
      expect(screen.getByRole('status')).toHaveTextContent('Nicht gespeicherte Änderungen');
      expect(saveButton()).toBeEnabled();
      view.unmount();
    },
  );

  it('requires an explicit EOL choice before saving a changed mixed-EOL document', async () => {
    const input = props(document('a\r\nb\nc'));
    const view = render(<WorkspaceEditor {...input} />);
    fireEvent.change(await editor(), { target: { value: 'a\nb\nc!' } });
    fireEvent.click(saveButton());
    expect(input.onSave).not.toHaveBeenCalled();
    expect(screen.getByText(/unterschiedliche Zeilenumbrüche/)).toBeVisible();
    fireEvent.change(screen.getByLabelText('Einheitliche Zeilenenden'), {
      target: { value: 'lf' },
    });
    expect(input.onSave).not.toHaveBeenCalled();
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(input.onSave).toHaveBeenCalledWith({ baseRevision: 0, bytes: bytes('a\nb\nc!') }),
    );
    view.unmount();
  });

  it.each(['empty_document', 'document_too_large'])(
    'allows correction and a fresh save after the local %s preflight rejects without effects',
    async (code) => {
      const input = props(document('Original\n'));
      input.onSave = jest.fn(input.onSave).mockRejectedValueOnce({ code });
      const view = render(<WorkspaceEditor {...input} />);
      try {
        const text = await editor();
        fireEvent.change(text, {
          target: { value: code === 'empty_document' ? '' : 'x'.repeat(65_537) },
        });
        fireEvent.click(saveButton());
        await waitFor(() => expect(saveButton()).toBeEnabled());
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        expect(input.onSave).toHaveBeenCalledTimes(1);
        fireEvent.change(text, { target: { value: 'Korrigierter Entwurf\n' } });
        expect(saveButton()).toBeEnabled();
        fireEvent.click(saveButton());
        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Gespeichert'));
        expect(input.onSave).toHaveBeenCalledTimes(2);
        expect(input.onSave).toHaveBeenLastCalledWith({
          baseRevision: 0,
          bytes: bytes('Korrigierter Entwurf\n'),
        });
        expect(text).toHaveValue('Korrigierter Entwurf\n');
        expect(input.onReload).not.toHaveBeenCalled();
        expect(saveButton()).toBeDisabled();
      } finally {
        view.unmount();
      }
    },
  );

  it.each(['revision_conflict', 'unavailable'])(
    'retains local text after %s and requires reconciliation before another save',
    async (code) => {
      const input = props();
      input.onSave = jest.fn().mockRejectedValue({ code });
      const view = render(<WorkspaceEditor {...input} />);
      const text = await editor();
      fireEvent.change(text, { target: { value: 'Privater lokaler Text' } });
      fireEvent.click(saveButton());
      await waitFor(() => expect(screen.getByRole('alert')).toBeVisible());
      expect(text).toHaveValue('Privater lokaler Text');
      expect(saveButton()).toBeDisabled();
      fireEvent.click(screen.getByRole('button', { name: 'Neu laden' }));
      expect(input.onReload).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Änderungen behalten' }));
      expect(text).toHaveValue('Privater lokaler Text');
      expect(screen.getByRole('button', { name: 'Neu laden' })).toHaveFocus();
      view.unmount();
    },
  );

  it('requires explicit discard before reloading and disposes the previous model', async () => {
    const input = props();
    const view = render(<WorkspaceEditor {...input} />);
    fireEvent.change(await editor(), { target: { value: 'Lokale Änderung' } });
    const previous = [...mockModels.values()][0];
    fireEvent.click(screen.getByRole('button', { name: 'Neu laden' }));
    expect(screen.getByRole('button', { name: 'Änderungen behalten' })).toHaveFocus();
    expect(input.onReload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Gespeicherte Version laden' }));
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('Server\n'));
    expect(previous.dispose).toHaveBeenCalledTimes(1);
    expect(input.onSave).not.toHaveBeenCalled();
    view.unmount();
  });

  it('does not discard a newer local edit that races a confirmed reload', async () => {
    const request = pending<WorkspaceEditorDocument>();
    const input = props();
    input.onReload = jest.fn(() => request.promise);
    const view = render(<WorkspaceEditor {...input} />);
    const text = await editor();
    fireEvent.change(text, { target: { value: 'Bestätigte Änderung' } });
    fireEvent.click(screen.getByRole('button', { name: 'Neu laden' }));
    fireEvent.click(screen.getByRole('button', { name: 'Gespeicherte Version laden' }));
    expect(text).toHaveAttribute('readonly');
    act(() => [...mockModels.values()][0].edit('Späte lokale Änderung'));
    await act(async () => request.resolve(document('Server\n', 1)));
    expect(text).toHaveValue('Späte lokale Änderung');
    expect(screen.getByRole('alert')).toHaveTextContent(/während des Ladens/);
    view.unmount();
  });

  it('disposes on ownership change and ignores the old save response', async () => {
    const request = pending<WorkspaceEditorDocument>();
    const input = props();
    input.onSave = jest.fn(() => request.promise);
    const view = render(<WorkspaceEditor {...input} />);
    fireEvent.change(await editor(), { target: { value: 'Alter Entwurf' } });
    fireEvent.click(saveButton());
    const old = [...mockModels.values()][0];
    view.rerender(
      <WorkspaceEditor
        {...input}
        identity={{ ...input.identity, ownerId: 'other-owner' }}
        initial={document('Neuer Nutzer\n')}
      />,
    );
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('Neuer Nutzer\n'));
    await act(async () => request.resolve(document('Alter Entwurf', 1)));
    expect(screen.getByRole('textbox')).toHaveValue('Neuer Nutzer\n');
    expect(old.dispose).toHaveBeenCalledTimes(1);
    expect(saveButton()).toBeDisabled();
    view.unmount();
  });

  it('ignores an initial-prop refresh while the same workspace contains manual edits', async () => {
    const input = props();
    const view = render(<WorkspaceEditor {...input} />);
    fireEvent.change(await editor(), { target: { value: 'Manueller Text' } });
    view.rerender(<WorkspaceEditor {...input} initial={document('Neue externe Version', 2)} />);
    expect(screen.getByRole('textbox')).toHaveValue('Manueller Text');
    view.unmount();
  });

  it('does not accept a save acknowledgment for different bytes', async () => {
    const input = props();
    input.onSave = jest.fn(async () => document('Andere Bytes', 1));
    const view = render(<WorkspaceEditor {...input} />);
    fireEvent.change(await editor(), { target: { value: 'Mein Text' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/nicht bestätigt/));
    expect(screen.getByRole('textbox')).toHaveValue('Mein Text');
    expect(saveButton()).toBeDisabled();
    view.unmount();
  });

  it('removes the model and content when a source is no longer authorized', async () => {
    const input = props();
    input.onSave = jest.fn().mockRejectedValue({ code: 'source_unavailable' });
    const view = render(<WorkspaceEditor {...input} />);
    fireEvent.change(await editor(), { target: { value: 'Entzug' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveTextContent(/nicht mehr verfügbar/);
    expect(mockModels.size).toBe(0);
    view.unmount();
  });

  it.each([
    ['security_rejected', 'com_upload_security_rejected'],
    ['security_uninspectable', 'com_upload_security_uninspectable'],
  ])('shows the existing distinct %s warning without another upload', async (code, key) => {
    const input = props();
    input.onSave = jest.fn().mockRejectedValue({ code });
    const view = render(<WorkspaceEditor {...input} />);
    fireEvent.change(await editor(), { target: { value: 'Synthetischer Prüftext' } });
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        (mockGerman as Record<string, string>)[key],
      ),
    );
    expect(input.onSave).toHaveBeenCalledTimes(1);
    expect(saveButton()).toBeDisabled();
    view.unmount();
  });

  it('does not create a model after unmounting during local loader initialization', async () => {
    const request = pending<typeof mockMonaco>();
    mockInitialize.mockImplementationOnce(() => request.promise);
    const view = render(<WorkspaceEditor {...props()} />);
    view.unmount();
    await act(async () => request.resolve(mockMonaco));
    expect(mockModels.size).toBe(0);
  });

  it('shows an error for invalid UTF-8 without creating a model', async () => {
    const input = props();
    input.initial.bytes = new Uint8Array([0xff]);
    const view = render(<WorkspaceEditor {...input} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/nicht geöffnet/);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(mockModels.size).toBe(0);
    view.unmount();
  });
});
