/** Private document editing; the caller owns authorized reads, intake and committed revisions. */
import { useContext, useEffect, useRef, useState } from 'react';
import { loader } from '@monaco-editor/react';
import { ThemeContext, useRemScale } from '@librechat/client';
import type { DocumentWorkspace } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks/useLocalize';
import MonacoEditor from '~/components/Artifacts/monaco';
import useLocalize from '~/hooks/useLocalize';
import { decodeWorkspaceText } from './codec';
import { createWorkspaceTextModel } from './model';
import type { WorkspaceSaveEol, WorkspaceTextSnapshot } from './codec';
import type { WorkspaceEditorIdentity, WorkspaceTextModel } from './model';

export type WorkspaceEditorDocument = { workspace: DocumentWorkspace; bytes: Uint8Array };
export interface WorkspaceEditorProps {
  identity: WorkspaceEditorIdentity;
  initial: WorkspaceEditorDocument;
  onSave(input: { baseRevision: number; bytes: Uint8Array }): Promise<WorkspaceEditorDocument>;
  onReload(): Promise<WorkspaceEditorDocument>;
}

type Seed = { workspace: DocumentWorkspace; snapshot: WorkspaceTextSnapshot };
type Failure =
  | 'load'
  | 'encoding'
  | 'save'
  | 'conflict'
  | 'reload'
  | 'edited'
  | 'unavailable'
  | 'security_rejected'
  | 'security_uninspectable'
  | null;
const actionClass =
  'min-h-10 rounded-lg border border-border-light px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 disabled:cursor-not-allowed disabled:opacity-50';
const failureKeys: Record<Exclude<Failure, null>, TranslationKeys> = {
  load: 'com_workspace_editor_load_error',
  encoding: 'com_workspace_editor_encoding_error',
  save: 'com_workspace_editor_save_error',
  conflict: 'com_workspace_editor_conflict_error',
  reload: 'com_workspace_editor_reload_error',
  edited: 'com_workspace_editor_edited_error',
  unavailable: 'com_workspace_editor_unavailable_error',
  security_rejected: 'com_upload_security_rejected',
  security_uninspectable: 'com_upload_security_uninspectable',
};

function readSeed(document: WorkspaceEditorDocument, identity: WorkspaceEditorIdentity): Seed {
  const { workspace } = document;
  if (
    workspace.workspaceId !== identity.workspaceId ||
    !Number.isSafeInteger(workspace.revision) ||
    workspace.revision < 0
  ) {
    throw new Error('Workspace response does not match the editor');
  }
  return { workspace: { ...workspace }, snapshot: decodeWorkspaceText(document.bytes) };
}

const errorCode = (error: unknown) =>
  error && typeof error === 'object' && 'code' in error ? error.code : undefined;

export function WorkspaceEditor(props: WorkspaceEditorProps) {
  const key = JSON.stringify([
    props.identity.tenantId,
    props.identity.ownerId,
    props.identity.workspaceId,
  ]);
  return <WorkspaceEditorSession key={key} {...props} />;
}

function WorkspaceEditorSession({ identity, initial, onSave, onReload }: WorkspaceEditorProps) {
  const localize = useLocalize();
  const { resolvedMode, highContrast } = useContext(ThemeContext);
  const remScale = useRemScale();
  const [scope] = useState(() => ({ ...identity }));
  const [seed, setSeed] = useState<Seed | null>(() => {
    try {
      return readSeed(initial, scope);
    } catch {
      return null;
    }
  });
  const [workspace, setWorkspace] = useState(initial.workspace);
  const [session, setSession] = useState<WorkspaceTextModel | null>(null);
  const current = useRef<WorkspaceTextModel | null>(null);
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState<'save' | 'reload' | null>(null);
  const busy = useRef(false);
  const [failure, setFailure] = useState<Failure>(seed ? null : 'load');
  const [saveHeld, setSaveHeld] = useState(false);
  const [needsEol, setNeedsEol] = useState(false);
  const [eol, setEol] = useState<WorkspaceSaveEol | ''>('');
  const [confirmReload, setConfirmReload] = useState(false);
  const keepButton = useRef<HTMLButtonElement>(null);
  const reloadButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!seed) return;
    let active = true;
    let owned: WorkspaceTextModel | undefined;
    let subscription: { dispose(): void } | undefined;
    // monaco.ts has already configured this shared loader with local assets.
    void loader
      .init()
      .then((monaco) => {
        if (!active) return;
        owned = createWorkspaceTextModel(monaco, scope, seed.workspace.revision, seed.snapshot);
        current.current = owned;
        const model = owned;
        subscription = model.model.onDidChangeContent(() => {
          if (current.current !== model) return;
          setDirty(model.isDirty());
          setFailure((previous) => (previous === 'encoding' ? null : previous));
        });
        setSession(model);
        setWorkspace(seed.workspace);
        setDirty(false);
        setPending(null);
        busy.current = false;
        setFailure(null);
        setSaveHeld(false);
        setNeedsEol(false);
        setEol('');
      })
      .catch(() => {
        if (active) setFailure('load');
      });
    return () => {
      active = false;
      if (current.current === owned) current.current = null;
      subscription?.dispose();
      owned?.dispose();
    };
  }, [seed, scope]);

  useEffect(() => {
    if (confirmReload) keepButton.current?.focus();
  }, [confirmReload]);

  const unavailable = () => {
    current.current?.dispose();
    current.current = null;
    setSession(null);
    setSeed(null);
    setDirty(false);
    setPending(null);
    busy.current = false;
    setConfirmReload(false);
    setFailure('unavailable');
  };

  const save = async () => {
    const model = current.current;
    if (!model || busy.current || saveHeld || !model.isDirty()) return;
    let candidate;
    try {
      candidate = model.encode(eol || undefined);
    } catch {
      setFailure('encoding');
      return;
    }
    if (candidate.status === 'unchanged') return;
    if (candidate.status === 'normalization-required') {
      setNeedsEol(true);
      return;
    }
    const baseRevision = model.revision;
    const submittedBytes = candidate.bytes;
    busy.current = true;
    setPending('save');
    setConfirmReload(false);
    setFailure(null);
    try {
      const response = await onSave({ baseRevision, bytes: new Uint8Array(submittedBytes) });
      if (current.current !== model) return;
      const accepted = readSeed(response, scope);
      const acceptedBytes = accepted.snapshot.originalBytes;
      if (
        acceptedBytes.length !== submittedBytes.length ||
        !acceptedBytes.every((byte, index) => byte === submittedBytes[index]) ||
        !model.markSaved(baseRevision, accepted.workspace.revision, accepted.snapshot)
      ) {
        throw new Error('Workspace save was not confirmed');
      }
      setWorkspace(accepted.workspace);
      setDirty(model.isDirty());
      setNeedsEol(false);
      setEol('');
    } catch (error) {
      if (current.current !== model) return;
      const code = errorCode(error);
      if (code === 'source_unavailable' || code === 'not_found') {
        unavailable();
      } else if (code === 'empty_document' || code === 'document_too_large') {
        // The panel presents these local corrections; no write needs reconciliation.
        setFailure(null);
        setSaveHeld(false);
      } else {
        if (code === 'security_rejected' || code === 'security_uninspectable') setFailure(code);
        else setFailure(code === 'revision_conflict' ? 'conflict' : 'save');
        setSaveHeld(true);
      }
    } finally {
      if (current.current === model) {
        busy.current = false;
        setPending(null);
      }
    }
  };

  const reload = async () => {
    const model = current.current;
    if (!model || busy.current) return;
    const version = model.model.getVersionId();
    let replacing = false;
    busy.current = true;
    setPending('reload');
    setConfirmReload(false);
    setFailure(null);
    try {
      const response = await onReload();
      if (current.current !== model) return;
      const next = readSeed(response, scope);
      if (model.model.getVersionId() !== version) {
        setFailure('edited');
        return;
      }
      if (next.workspace.revision < model.revision) {
        throw new Error('Workspace revision went backwards');
      }
      replacing = true;
      setSession(null);
      setSeed(next);
    } catch (error) {
      if (current.current !== model) return;
      const code = errorCode(error);
      if (code === 'source_unavailable' || code === 'not_found') unavailable();
      else setFailure('reload');
    } finally {
      if (current.current === model && !replacing) {
        busy.current = false;
        setPending(null);
      }
    }
  };

  let status: TranslationKeys = dirty ? 'com_workspace_editor_dirty' : 'com_workspace_editor_saved';
  if (!session)
    status = failure ? 'com_workspace_editor_not_ready' : 'com_workspace_editor_loading';
  else if (pending === 'save') status = 'com_workspace_editor_saving';
  else if (pending === 'reload') status = 'com_workspace_editor_reloading';
  let theme = resolvedMode === 'dark' ? 'vs-dark' : 'light';
  if (highContrast) theme = resolvedMode === 'dark' ? 'hc-black' : 'hc-light';

  return (
    <section
      aria-label={localize('com_workspace_editor_title')}
      className="bg-surface-primary text-text-primary flex h-full min-h-0 w-full flex-col"
      onKeyDownCapture={(event) => {
        if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's') {
          event.preventDefault();
          void save();
        }
      }}
    >
      <header className="border-border-light flex shrink-0 flex-wrap items-start justify-between gap-3 border-b p-3">
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold break-words">
            {failure === 'unavailable'
              ? localize('com_workspace_editor_unavailable_title')
              : workspace.title}
          </h2>
          <p
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="text-text-secondary mt-1 text-sm"
          >
            {localize(status)}
          </p>
          <p className="text-text-secondary text-xs">{localize('com_workspace_editor_reminder')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            ref={reloadButton}
            type="button"
            className={actionClass}
            disabled={!session || !!pending}
            onClick={() => {
              if (dirty) setConfirmReload(true);
              else void reload();
            }}
          >
            {localize('com_workspace_editor_reload')}
          </button>
          <button
            type="button"
            className={actionClass}
            disabled={!session || !dirty || !!pending || saveHeld || (needsEol && !eol)}
            aria-keyshortcuts="Control+s Meta+s"
            onClick={() => void save()}
          >
            {localize('com_workspace_editor_save')}
          </button>
        </div>
      </header>
      {failure && (
        <p role="alert" className="border-border-light border-b p-3 text-sm">
          {localize(failureKeys[failure])}
        </p>
      )}
      {confirmReload && (
        <div
          role="group"
          aria-label={localize('com_workspace_editor_unsaved_title')}
          className="border-border-light border-b p-3 text-sm"
        >
          <p>{localize('com_workspace_editor_discard_warning')}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              ref={keepButton}
              type="button"
              className={actionClass}
              onClick={() => {
                setConfirmReload(false);
                reloadButton.current?.focus();
              }}
            >
              {localize('com_workspace_editor_keep')}
            </button>
            <button type="button" className={actionClass} onClick={() => void reload()}>
              {localize('com_workspace_editor_load_saved')}
            </button>
          </div>
        </div>
      )}
      {needsEol && dirty && (
        <div className="border-border-light border-b p-3 text-sm">
          <p>{localize('com_workspace_editor_eol_notice')}</p>
          <label className="mt-2 flex flex-wrap items-center gap-2">
            {localize('com_workspace_editor_eol_label')}
            <select
              className="bg-surface-primary border-border-light min-h-10 rounded border px-2"
              value={eol}
              disabled={!!pending}
              onChange={(event) => setEol(event.target.value as WorkspaceSaveEol | '')}
            >
              <option value="">{localize('com_workspace_editor_eol_select')}</option>
              <option value="lf">{localize('com_workspace_editor_eol_lf')}</option>
              <option value="crlf">{localize('com_workspace_editor_eol_crlf')}</option>
            </select>
          </label>
        </div>
      )}
      <div className="min-h-72 flex-1">
        {session && (
          <MonacoEditor
            path={session.uri}
            keepCurrentModel
            saveViewState={false}
            language={workspace.format === 'markdown' ? 'markdown' : 'plaintext'}
            theme={theme}
            loading={localize('com_workspace_editor_monaco_loading')}
            height="100%"
            options={{
              ariaLabel: localize('com_workspace_editor_content_label'),
              readOnly: pending === 'reload',
              wordWrap: 'on',
              minimap: { enabled: false },
              fontSize: 14 * remScale,
              automaticLayout: true,
              scrollBeyondLastLine: false,
              renderWhitespace: 'selection',
              tabSize: 2,
            }}
          />
        )}
      </div>
    </section>
  );
}
