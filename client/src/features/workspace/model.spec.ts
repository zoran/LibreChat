import type { editor, Uri } from 'monaco-editor';
import { decodeWorkspaceText } from './codec';
import { createWorkspaceTextModel } from './model';
import type { WorkspaceMonaco } from './model';

const identity = { tenantId: 'tenant', ownerId: 'owner', workspaceId: 'workspace' };
const snapshot = (text = 'Original\r\n') => decodeWorkspaceText(new TextEncoder().encode(text));

/** This port double checks adapter policy/calls, not Monaco's actual Undo implementation. */
function monacoPort() {
  let value = '';
  let version = 1;
  let disposed = false;
  const model = {
    id: 'model-1',
    getVersionId: jest.fn(() => version),
    getValue: jest.fn(() => value),
    getFullModelRange: jest.fn(() => ({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 2,
      endColumn: 1,
    })),
    pushStackElement: jest.fn(),
    pushEditOperations: jest.fn((_cursor, edits) => {
      value = edits[0].text;
      version += 1;
      return null;
    }),
    isDisposed: jest.fn(() => disposed),
    dispose: jest.fn(() => {
      disposed = true;
    }),
  };
  const monaco = {
    Uri: { parse: jest.fn((uri: string) => ({ toString: () => uri }) as Uri) },
    editor: {
      getModel: jest.fn(() => null as editor.ITextModel | null),
      createModel: jest.fn((text: string) => {
        value = text.replace(/^\uFEFF/, '');
        return model as unknown as editor.ITextModel;
      }),
    },
  } satisfies WorkspaceMonaco;
  return {
    model,
    monaco,
    edit: (text: string) => {
      value = text;
      version += 1;
    },
  };
}

describe('workspace model ownership and suggestion fences', () => {
  it('initializes one stable scoped model without creating an edit or a changed save candidate', () => {
    const port = monacoPort();
    const session = createWorkspaceTextModel(port.monaco, identity, 7, snapshot());
    expect(session.model).toBe(port.model);
    expect(session.uri).toBe('cortex-workspace://text/tenant/owner/workspace');
    expect(port.monaco.editor.createModel).toHaveBeenCalledTimes(1);
    expect(port.model.pushEditOperations).not.toHaveBeenCalled();
    expect(session.encode()).toMatchObject({ status: 'unchanged' });
    expect(session.isDirty()).toBe(false);
    expect(port.model.getValue).toHaveBeenLastCalledWith(1, false);
  });

  it('refuses to adopt or dispose a model already registered under the same identity', () => {
    const port = monacoPort();
    port.monaco.editor.getModel.mockReturnValue(port.model as unknown as editor.ITextModel);
    expect(() => createWorkspaceTextModel(port.monaco, identity, 0, snapshot())).toThrow();
    expect(port.monaco.editor.createModel).not.toHaveBeenCalled();
    expect(port.model.dispose).not.toHaveBeenCalled();
  });

  it('keeps a literal leading text BOM independently from the original file BOM', () => {
    const port = monacoPort();
    const session = createWorkspaceTextModel(
      port.monaco,
      identity,
      0,
      snapshot('\uFEFF\uFEFFText\r\n'),
    );
    expect(session.readText()).toBe('\uFEFFText\n');
    expect(session.encode()).toMatchObject({ status: 'unchanged' });
    const base = session.captureSuggestionBase();
    expect(session.applySuggestion(base, 'Changed\n')).toBe('applied');
    expect(session.encode()).toMatchObject({
      status: 'changed',
      bytes: new TextEncoder().encode('\uFEFFChanged\r\n'),
    });
  });

  it('applies a matching suggestion as one Undo group and leaves saving to the caller', () => {
    const port = monacoPort();
    const session = createWorkspaceTextModel(port.monaco, identity, 2, snapshot());
    const base = session.captureSuggestionBase();
    expect(session.applySuggestion(base, 'Vorschlag\n')).toBe('applied');
    expect(port.model.pushStackElement).toHaveBeenCalledTimes(2);
    expect(port.model.pushEditOperations).toHaveBeenCalledTimes(1);
    expect(port.model.pushEditOperations).toHaveBeenCalledWith(
      null,
      [
        {
          range: port.model.getFullModelRange(),
          text: 'Vorschlag\n',
          forceMoveMarkers: true,
        },
      ],
      expect.any(Function),
    );
    expect(session.revision).toBe(2);
    expect(session.isDirty()).toBe(true);
    port.edit('Original\n');
    expect(session.isDirty()).toBe(false);
    expect(session.encode()).toMatchObject({ status: 'unchanged' });
  });

  it.each(['identity', 'revision', 'model', 'version', 'text'])(
    'rejects a changed %s fence without an edit',
    (field) => {
      const port = monacoPort();
      const session = createWorkspaceTextModel(port.monaco, identity, 2, snapshot());
      const base = session.captureSuggestionBase();
      const changed = {
        ...base,
        ...(field === 'identity' ? { identity: { ...identity, ownerId: 'foreign' } } : {}),
        ...(field === 'revision' ? { revision: 1 } : {}),
        ...(field === 'model' ? { modelId: 'other-instance' } : {}),
        ...(field === 'version' ? { modelVersion: 0 } : {}),
        ...(field === 'text' ? { text: 'other' } : {}),
      };
      expect(session.applySuggestion(changed, 'Vorschlag')).toBe('conflict');
      expect(port.model.pushEditOperations).not.toHaveBeenCalled();
      expect(port.model.pushStackElement).not.toHaveBeenCalled();
    },
  );

  it('does not overwrite edits made while an earlier snapshot was being saved', () => {
    const port = monacoPort();
    const session = createWorkspaceTextModel(port.monaco, identity, 2, snapshot());
    port.edit('Gespeicherter Zwischenstand\n');
    const captured = snapshot('Gespeicherter Zwischenstand\r\n');
    port.edit('Noch nicht gespeichert\n');
    expect(session.markSaved(2, 3, captured)).toBe(true);
    expect(session.revision).toBe(3);
    expect(session.readText()).toBe('Noch nicht gespeichert\n');
    expect(session.isDirty()).toBe(true);
    expect(session.markSaved(2, 3, captured)).toBe(false);
    expect(port.model.pushEditOperations).not.toHaveBeenCalled();
  });

  it('rejects a pre-save suggestion and does not edit for an unchanged candidate', () => {
    const port = monacoPort();
    const session = createWorkspaceTextModel(port.monaco, identity, 2, snapshot());
    const old = session.captureSuggestionBase();
    expect(session.applySuggestion(old, old.text)).toBe('unchanged');
    expect(session.markSaved(2, 3, snapshot())).toBe(true);
    expect(session.applySuggestion(old, 'late')).toBe('conflict');
    expect(port.model.pushEditOperations).not.toHaveBeenCalled();
  });

  it('rejects a suggestion from a disposed model after reopening the same saved workspace', () => {
    const firstPort = monacoPort();
    const first = createWorkspaceTextModel(firstPort.monaco, identity, 2, snapshot());
    const old = first.captureSuggestionBase();
    first.dispose();
    const nextPort = monacoPort();
    nextPort.model.id = 'model-2';
    const next = createWorkspaceTextModel(nextPort.monaco, identity, 2, snapshot());
    expect(next.applySuggestion(old, 'late')).toBe('conflict');
    expect(nextPort.model.pushEditOperations).not.toHaveBeenCalled();
  });

  it('rejects invalid suggestion Unicode before touching the Undo stack', () => {
    const port = monacoPort();
    const session = createWorkspaceTextModel(port.monaco, identity, 2, snapshot());
    expect(() => session.applySuggestion(session.captureSuggestionBase(), '\uD800')).toThrow();
    expect(port.model.pushStackElement).not.toHaveBeenCalled();
    expect(port.model.pushEditOperations).not.toHaveBeenCalled();
  });

  it('disposes only its own model once and refuses late work after ownership ends', () => {
    const port = monacoPort();
    const session = createWorkspaceTextModel(port.monaco, identity, 2, snapshot());
    const base = session.captureSuggestionBase();
    session.dispose();
    session.dispose();
    expect(port.model.dispose).toHaveBeenCalledTimes(1);
    expect(session.applySuggestion(base, 'late')).toBe('conflict');
    expect(session.markSaved(2, 3, snapshot('late'))).toBe(false);
    expect(() => session.encode()).toThrow();
    expect(() => session.model).toThrow();
    expect(port.model.pushEditOperations).not.toHaveBeenCalled();
  });
});
