/** One workspace owns one transient Monaco model; persistence and authorization stay outside it. */
import type { editor, Uri } from 'monaco-editor';
import { assertWorkspaceModelText, encodeWorkspaceText } from './codec';
import type { WorkspaceSaveEol, WorkspaceTextSnapshot } from './codec';

export interface WorkspaceEditorIdentity {
  readonly tenantId: string;
  readonly ownerId: string;
  readonly workspaceId: string;
}

/** Inject the existing locally bundled Monaco instance; do not start another loader. */
export interface WorkspaceMonaco {
  Uri: { parse(value: string): Uri };
  editor: {
    getModel(uri: Uri): editor.ITextModel | null;
    createModel(value: string, language?: string, uri?: Uri): editor.ITextModel;
  };
}

export interface WorkspaceSuggestionBase {
  readonly identity: WorkspaceEditorIdentity;
  readonly revision: number;
  /** Native model identity changes when the same workspace is reopened after disposal. */
  readonly modelId: string;
  readonly modelVersion: number;
  readonly text: string;
}

const lfPreference: editor.EndOfLinePreference = 1;
const validRevision = (revision: number) => Number.isSafeInteger(revision) && revision >= 0;

export function createWorkspaceTextModel(
  monaco: WorkspaceMonaco,
  identity: WorkspaceEditorIdentity,
  initialRevision: number,
  initialSnapshot: WorkspaceTextSnapshot,
) {
  const scope = Object.freeze({
    tenantId: identity.tenantId,
    ownerId: identity.ownerId,
    workspaceId: identity.workspaceId,
  });
  if (Object.values(scope).some((part) => typeof part !== 'string' || !part)) {
    throw new Error('A complete workspace model identity is required');
  }
  if (!validRevision(initialRevision)) {
    throw new Error('A valid workspace revision is required');
  }
  assertWorkspaceModelText(initialSnapshot.text);
  const uri = `cortex-workspace://text/${[scope.tenantId, scope.ownerId, scope.workspaceId]
    .map(encodeURIComponent)
    .join('/')}`;
  const modelUri = monaco.Uri.parse(uri);
  if (monaco.editor.getModel(modelUri)) {
    throw new Error('The workspace model already has an owner');
  }
  // Monaco consumes one leading BOM at construction. Preserve an actual text BOM behind it;
  // reads below always exclude that model metadata, while the codec owns the file BOM.
  const initialText = initialSnapshot.text.startsWith('\uFEFF')
    ? '\uFEFF' + initialSnapshot.text
    : initialSnapshot.text;
  const model = monaco.editor.createModel(initialText, 'plaintext', modelUri);
  let snapshot: WorkspaceTextSnapshot | null = initialSnapshot;
  let revision = initialRevision;
  let disposed = false;

  const active = () => !disposed && !model.isDisposed() && snapshot !== null;
  const requireSnapshot = () => {
    if (!active() || !snapshot) throw new Error('The workspace model is disposed');
    return snapshot;
  };
  const readText = () => {
    requireSnapshot();
    return model.getValue(lfPreference, false);
  };

  return {
    uri,
    identity: scope,
    get model() {
      requireSnapshot();
      return model;
    },
    get revision() {
      return revision;
    },
    readText,
    isDirty: () => readText() !== requireSnapshot().text,
    encode: (explicitEol?: WorkspaceSaveEol) =>
      encodeWorkspaceText(requireSnapshot(), readText(), explicitEol),
    captureSuggestionBase(): WorkspaceSuggestionBase {
      return Object.freeze({
        identity: scope,
        revision,
        modelId: model.id,
        modelVersion: model.getVersionId(),
        text: readText(),
      });
    },
    applySuggestion(
      base: WorkspaceSuggestionBase,
      text: string,
    ): 'applied' | 'unchanged' | 'conflict' {
      if (
        !active() ||
        base.identity.tenantId !== scope.tenantId ||
        base.identity.ownerId !== scope.ownerId ||
        base.identity.workspaceId !== scope.workspaceId ||
        base.revision !== revision ||
        base.modelId !== model.id ||
        base.modelVersion !== model.getVersionId() ||
        base.text !== readText()
      ) {
        return 'conflict';
      }
      assertWorkspaceModelText(text);
      if (text === base.text) return 'unchanged';
      model.pushStackElement();
      model.pushEditOperations(
        null,
        [{ range: model.getFullModelRange(), text, forceMoveMarkers: true }],
        () => null,
      );
      model.pushStackElement();
      return 'applied';
    },
    /** Call only after the actual server commit/reconciliation, using the bytes it accepted. */
    markSaved(
      expectedRevision: number,
      nextRevision: number,
      savedSnapshot: WorkspaceTextSnapshot,
    ): boolean {
      if (
        !active() ||
        revision !== expectedRevision ||
        !validRevision(nextRevision) ||
        nextRevision <= expectedRevision
      ) {
        return false;
      }
      assertWorkspaceModelText(savedSnapshot.text);
      snapshot = savedSnapshot;
      revision = nextRevision;
      return true;
    },
    /** Detach for a pane switch; dispose when the owning workspace/auth scope ends. */
    dispose() {
      if (disposed) return;
      disposed = true;
      snapshot = null;
      if (!model.isDisposed()) model.dispose();
    },
  };
}

export type WorkspaceTextModel = ReturnType<typeof createWorkspaceTextModel>;
