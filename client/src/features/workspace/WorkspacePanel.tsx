import { useEffect, useRef, useState } from 'react';
import type { DocumentWorkspace, DocumentWorkspaceFormat } from 'librechat-data-provider';
import useLocalize from '~/hooks/useLocalize';
import type { TranslationKeys } from '~/hooks/useLocalize';
import {
  createWorkspace,
  listWorkspaces,
  loadWorkspace,
  loadWorkspaceRevision,
  saveWorkspace,
} from './api';
import { WorkspaceEditor } from './WorkspaceEditor';
import type { WorkspaceEditorDocument } from './WorkspaceEditor';

export interface WorkspacePanelProps {
  owner: { ownerId: string; tenantId: string | null };
  enabled: boolean;
}

type Target = { kind: 'open'; id: string } | { kind: 'create'; format: DocumentWorkspaceFormat };
const actionClass =
  'min-h-10 rounded-lg border border-border-light px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 disabled:cursor-not-allowed disabled:opacity-50';
const codeOf = (error: unknown) =>
  error && typeof error === 'object' && 'code' in error ? error.code : undefined;
const saveErrors: Record<string, TranslationKeys> = {
  empty_document: 'com_workspace_panel_empty_error',
  document_too_large: 'com_workspace_panel_size_error',
  quota_exceeded: 'com_workspace_panel_quota_error',
  rate_limited: 'com_workspace_panel_rate_error',
  save_timeout: 'com_workspace_panel_save_timeout',
};

export function WorkspacePanel({ owner, enabled }: WorkspacePanelProps) {
  if (!enabled) return null;
  return (
    <WorkspacePanelSession key={JSON.stringify([owner.tenantId, owner.ownerId])} owner={owner} />
  );
}

function WorkspacePanelSession({ owner }: Pick<WorkspacePanelProps, 'owner'>) {
  const localize = useLocalize();
  const controller = useRef(new AbortController());
  const alive = useRef(true);
  const latch = useRef(false);
  const [items, setItems] = useState<DocumentWorkspace[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [editorBusy, setEditorBusy] = useState(false);
  const [ended, setEnded] = useState(false);
  const [createHeld, setCreateHeld] = useState(false);
  const [failure, setFailure] = useState<TranslationKeys | null>(null);
  const [format, setFormat] = useState<DocumentWorkspaceFormat>('markdown');
  const [document, setDocument] = useState<WorkspaceEditorDocument | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [target, setTarget] = useState<Target | null>(null);
  const keep = useRef<HTMLButtonElement>(null);
  const active = (signal = controller.current.signal) =>
    alive.current && signal === controller.current.signal && !signal.aborted;

  const invalidate = () => {
    controller.current.abort();
    setDocument(null);
    setItems([]);
    setShowEditor(false);
    setCursor(null);
    setTarget(null);
    setEnded(true);
    setLoading(false);
    setWorking(false);
    setFailure('com_workspace_panel_unavailable');
  };

  const failed = (
    error: unknown,
    fallback: TranslationKeys,
    signal = controller.current.signal,
  ) => {
    if (!active(signal)) return;
    const code = codeOf(error);
    if (code === 'source_unavailable' || code === 'not_found') invalidate();
    else setFailure(typeof code === 'string' ? (saveErrors[code] ?? fallback) : fallback);
  };

  const refresh = async (before?: string) => {
    if (!active() || latch.current) return;
    const signal = controller.current.signal;
    latch.current = true;
    setLoading(true);
    setFailure(null);
    try {
      const result = await listWorkspaces(signal, before);
      if (!active(signal)) return;
      setItems((previous) => [
        ...new Map(
          [...(before ? previous : []), ...result.workspaces].map((item) => [
            item.workspaceId,
            item,
          ]),
        ).values(),
      ]);
      setCursor(result.nextCursor === before ? null : result.nextCursor);
      setCreateHeld(false);
    } catch (error) {
      failed(error, 'com_workspace_panel_load_error', signal);
    } finally {
      if (active(signal)) {
        latch.current = false;
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    controller.current = new AbortController();
    const owned = controller.current;
    alive.current = true;
    latch.current = false;
    void refresh();
    const sessionEnded = () => invalidate();
    window.addEventListener('librechat:auth-session-ending', sessionEnded);
    return () => {
      alive.current = false;
      owned.abort();
      window.removeEventListener('librechat:auth-session-ending', sessionEnded);
    };
    // The keyed session owns one controller and one initial request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller]);

  useEffect(() => {
    if (target) keep.current?.focus();
  }, [target]);

  const start = async (next: Target) => {
    if (!active() || latch.current || editorBusy) return;
    const signal = controller.current.signal;
    latch.current = true;
    setWorking(true);
    setShowEditor(false);
    setTarget(null);
    setFailure(null);
    try {
      const opened =
        next.kind === 'open'
          ? await loadWorkspace(next.id, signal)
          : { workspace: await createWorkspace(next.format, signal), bytes: new Uint8Array() };
      if (!active(signal)) return;
      setDocument(opened);
      setItems((previous) => [
        opened.workspace,
        ...previous.filter((item) => item.workspaceId !== opened.workspace.workspaceId),
      ]);
      setShowEditor(true);
    } catch (error) {
      if (next.kind === 'create' && active(signal)) setCreateHeld(true);
      failed(
        error,
        next.kind === 'open'
          ? 'com_workspace_panel_open_error'
          : 'com_workspace_panel_create_error',
        signal,
      );
    } finally {
      if (active(signal)) {
        latch.current = false;
        setWorking(false);
      }
    }
  };

  const choose = (next: Target) => {
    if (next.kind === 'open' && next.id === document?.workspace.workspaceId) {
      setShowEditor(true);
      return;
    }
    if (document) setTarget(next);
    else void start(next);
  };

  const update = (saved: WorkspaceEditorDocument) => {
    setDocument(saved);
    setItems((previous) =>
      previous.map((item) =>
        item.workspaceId === saved.workspace.workspaceId ? saved.workspace : item,
      ),
    );
  };
  const disabled = loading || working || editorBusy || ended;

  return (
    <section
      aria-label={localize('com_workspace_panel_title')}
      className="bg-surface-primary text-text-primary flex h-full min-h-0 flex-col"
    >
      <header className="border-border-light shrink-0 border-b p-3">
        <h1 className="text-lg font-semibold">{localize('com_workspace_panel_title')}</h1>
        <p className="text-text-secondary mt-1 text-sm">
          {localize('com_workspace_panel_description')}
        </p>
        <p className="text-text-secondary mt-1 text-xs">{localize('com_workspace_panel_limit')}</p>
        {showEditor && (
          <button
            type="button"
            className={`${actionClass} mt-3`}
            onClick={() => setShowEditor(false)}
          >
            {localize('com_workspace_panel_back')}
          </button>
        )}
      </header>
      {failure && (
        <p role="alert" className="p-3 text-sm">
          {localize(failure)}
        </p>
      )}
      {target && (
        <div
          role="group"
          aria-label={localize('com_workspace_panel_switch_title')}
          className="border-border-light border-b p-3"
        >
          <p>{localize('com_workspace_panel_switch_warning')}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              ref={keep}
              type="button"
              className={actionClass}
              onClick={() => {
                setTarget(null);
                setShowEditor(true);
              }}
            >
              {localize('com_workspace_panel_keep')}
            </button>
            <button
              type="button"
              className={actionClass}
              disabled={disabled}
              onClick={() => void start(target)}
            >
              {localize('com_workspace_panel_switch')}
            </button>
          </div>
        </div>
      )}
      <div hidden={showEditor} className="min-h-0 flex-1 overflow-auto p-3">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <label className="flex flex-wrap items-center gap-2 text-sm">
            {localize('com_workspace_panel_format')}
            <select
              className="bg-surface-primary border-border-light min-h-10 rounded border px-2"
              value={format}
              disabled={disabled || createHeld}
              onChange={(event) => setFormat(event.target.value as DocumentWorkspaceFormat)}
            >
              <option value="markdown">{localize('com_workspace_panel_markdown')}</option>
              <option value="text">{localize('com_workspace_panel_text')}</option>
            </select>
          </label>
          <button
            type="button"
            className={actionClass}
            disabled={disabled || createHeld}
            onClick={() => choose({ kind: 'create', format })}
          >
            {localize('com_workspace_panel_create')}
          </button>
          <button
            type="button"
            className={actionClass}
            disabled={disabled}
            onClick={() => void refresh()}
          >
            {localize('com_workspace_panel_retry')}
          </button>
          {document && (
            <button
              type="button"
              className={actionClass}
              disabled={working || ended}
              onClick={() => setShowEditor(true)}
            >
              {localize('com_workspace_panel_continue')}
            </button>
          )}
        </div>
        {(loading || working) && (
          <p role="status">
            {localize(loading ? 'com_workspace_panel_loading' : 'com_workspace_panel_working')}
          </p>
        )}
        {!loading && !items.length && !failure && <p>{localize('com_workspace_panel_empty')}</p>}
        <ul className="space-y-2">
          {items.map((item) => (
            <li key={item.workspaceId} className="border-border-light rounded-lg border p-3">
              <button
                type="button"
                className={`${actionClass} max-w-full text-left break-words`}
                disabled={disabled}
                onClick={() => choose({ kind: 'open', id: item.workspaceId })}
              >
                {item.title}
              </button>
              <p className="text-text-secondary mt-1 text-xs">
                {localize('com_workspace_panel_revision')} {item.revision} ·{' '}
                {localize(
                  item.format === 'markdown'
                    ? 'com_workspace_panel_markdown'
                    : 'com_workspace_panel_text',
                )}
              </p>
              {item.expiresAt && (
                <p className="text-text-secondary text-xs">
                  {localize('com_workspace_panel_expires')}{' '}
                  <time dateTime={item.expiresAt}>{item.expiresAt}</time>
                </p>
              )}
            </li>
          ))}
        </ul>
        {cursor && (
          <button
            type="button"
            className={`${actionClass} mt-3`}
            disabled={disabled}
            onClick={() => void refresh(cursor)}
          >
            {localize('com_workspace_panel_more')}
          </button>
        )}
      </div>
      {document && (
        <div hidden={!showEditor} className="min-h-0 flex-1">
          <WorkspaceEditor
            identity={{
              ownerId: owner.ownerId,
              tenantId: owner.tenantId === null ? 'personal' : `tenant:${owner.tenantId}`,
              workspaceId: document.workspace.workspaceId,
            }}
            initial={document}
            onReadRevision={async (revision, caller) => {
              const ownerSignal = controller.current.signal;
              const combined = new AbortController();
              const abort = () => combined.abort();
              ownerSignal.addEventListener('abort', abort, { once: true });
              caller.addEventListener('abort', abort, { once: true });
              try {
                if (!active(ownerSignal) || caller.aborted) abort();
                combined.signal.throwIfAborted();
                const loaded = await loadWorkspaceRevision(
                  document.workspace.workspaceId,
                  revision,
                  combined.signal,
                );
                if (!active(ownerSignal) || caller.aborted) abort();
                combined.signal.throwIfAborted();
                return loaded;
              } catch (error) {
                if (
                  active(ownerSignal) &&
                  !caller.aborted &&
                  codeOf(error) === 'source_unavailable'
                )
                  invalidate();
                throw error;
              } finally {
                ownerSignal.removeEventListener('abort', abort);
                caller.removeEventListener('abort', abort);
              }
            }}
            onSave={async (input) => {
              const signal = controller.current.signal;
              setEditorBusy(true);
              setFailure(null);
              try {
                const saved = await saveWorkspace(document.workspace.workspaceId, input, signal);
                if (active(signal)) update(saved);
                return saved;
              } catch (error) {
                const code = codeOf(error);
                if (typeof code === 'string' && saveErrors[code])
                  failed(error, saveErrors[code], signal);
                else if (code === 'source_unavailable' || code === 'not_found')
                  failed(error, 'com_workspace_panel_unavailable', signal);
                throw error;
              } finally {
                if (active(signal)) setEditorBusy(false);
              }
            }}
            onReload={async () => {
              const signal = controller.current.signal;
              setEditorBusy(true);
              setFailure(null);
              try {
                const loaded = await loadWorkspace(document.workspace.workspaceId, signal);
                if (active(signal)) update(loaded);
                return loaded;
              } catch (error) {
                if (codeOf(error) === 'source_unavailable' || codeOf(error) === 'not_found')
                  failed(error, 'com_workspace_panel_unavailable', signal);
                throw error;
              } finally {
                if (active(signal)) setEditorBusy(false);
              }
            }}
          />
        </div>
      )}
    </section>
  );
}
