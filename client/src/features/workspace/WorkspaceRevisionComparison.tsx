/** Read-only comparison inside one editor lifetime; no revision or file writes belong here. */
import { useEffect, useRef, useState } from 'react';
import { DiffEditor } from '~/components/Artifacts/monaco';
import useLocalize from '~/hooks/useLocalize';
import { assertWorkspaceModelText, decodeWorkspaceText } from './codec';
import type { WorkspaceRevisionContent } from './api';
import type { WorkspaceSuggestionBase, WorkspaceTextModel } from './model';

type Comparison = { revision: number; base: WorkspaceSuggestionBase; stored: string };
type Failure = 'invalid' | 'limit' | 'unavailable' | 'error' | null;
const actionClass =
  'min-h-10 rounded-lg border border-border-light px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 disabled:cursor-not-allowed disabled:opacity-50';

function matches(model: WorkspaceTextModel, base: WorkspaceSuggestionBase): boolean {
  try {
    return (
      model.model.id === base.modelId &&
      model.revision === base.revision &&
      model.model.getVersionId() === base.modelVersion &&
      model.readText() === base.text
    );
  } catch {
    return false;
  }
}

export function WorkspaceRevisionComparison({
  model,
  revision,
  disabled,
  language,
  theme,
  onReadRevision,
  onUnavailable,
  onClose,
}: {
  model: WorkspaceTextModel;
  revision: number;
  disabled: boolean;
  language: string;
  theme: string;
  onReadRevision(revision: number, signal: AbortSignal): Promise<WorkspaceRevisionContent>;
  onUnavailable(): void;
  onClose(): void;
}) {
  const localize = useLocalize();
  const [selected, setSelected] = useState(String(revision));
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<Failure>(null);
  const [stale, setStale] = useState(false);
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const alive = useRef(true);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    alive.current = true;
    input.current?.focus();
    return () => {
      alive.current = false;
      generation.current += 1;
      request.current?.abort();
      request.current = null;
    };
  }, [model]);

  useEffect(() => {
    if (!comparison) return;
    const changed = () => setStale(!matches(model, comparison.base));
    changed();
    const subscription = model.model.onDidChangeContent(changed);
    return () => subscription.dispose();
  }, [comparison, model, revision]);

  const cancel = () => {
    generation.current += 1;
    request.current?.abort();
    request.current = null;
    setLoading(false);
  };
  const close = () => {
    cancel();
    onClose();
  };
  const compare = async () => {
    if (disabled || request.current || !alive.current) return;
    const selectedRevision = Number(selected);
    setComparison(null);
    setFailure(null);
    setStale(false);
    if (
      !/^[1-9][0-9]*$/.test(selected) ||
      !Number.isSafeInteger(selectedRevision) ||
      selectedRevision > revision
    ) {
      setFailure('invalid');
      return;
    }
    let base: WorkspaceSuggestionBase;
    try {
      base = model.captureSuggestionBase();
      if (base.text.length > 65_536) {
        setFailure('limit');
        return;
      }
      assertWorkspaceModelText(base.text);
      if (new TextEncoder().encode(base.text).byteLength > 65_536) {
        setFailure('limit');
        return;
      }
    } catch {
      setFailure('error');
      return;
    }
    const controller = new AbortController();
    const currentGeneration = ++generation.current;
    request.current = controller;
    setLoading(true);
    const active = () =>
      alive.current &&
      currentGeneration === generation.current &&
      request.current === controller &&
      !controller.signal.aborted;
    try {
      const result = await onReadRevision(selectedRevision, controller.signal);
      if (!active()) return;
      if (
        result.workspaceId !== model.identity.workspaceId ||
        result.revision !== selectedRevision ||
        !(result.bytes instanceof Uint8Array) ||
        result.bytes.byteLength > 65_536
      )
        throw new Error('Invalid historical revision');
      const stored = decodeWorkspaceText(result.bytes).text;
      setComparison({ revision: selectedRevision, base, stored });
      setStale(!matches(model, base));
    } catch (error) {
      if (!active()) return;
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      const status =
        error && typeof error === 'object' && 'status' in error ? error.status : undefined;
      if (code === 'source_unavailable' || status === 401 || status === 403) onUnavailable();
      else setFailure(code === 'not_found' || status === 404 ? 'unavailable' : 'error');
    } finally {
      if (active()) {
        request.current = null;
        setLoading(false);
      }
    }
  };

  return (
    <section
      id="workspace-revision-comparison"
      aria-label={localize('com_workspace_compare_title')}
      className="border-border-light bg-surface-secondary max-h-[55%] shrink-0 overflow-y-auto border-b p-3 text-sm"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          close();
        }
      }}
    >
      <h3 className="font-semibold">{localize('com_workspace_compare_title')}</h3>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <label className="flex min-w-0 flex-col gap-1">
          {localize('com_workspace_compare_revision')}
          <input
            ref={input}
            type="number"
            min={1}
            max={revision}
            step={1}
            className="border-border-light bg-surface-primary min-h-10 w-28 max-w-full rounded border px-2"
            value={selected}
            onChange={(event) => {
              cancel();
              setSelected(event.target.value);
              setComparison(null);
              setFailure(null);
              setStale(false);
            }}
          />
        </label>
        <button
          type="button"
          className={actionClass}
          disabled={disabled || loading}
          onClick={() => void compare()}
        >
          {localize('com_workspace_compare_load')}
        </button>
        <button type="button" className={actionClass} onClick={close}>
          {localize('com_workspace_compare_close')}
        </button>
      </div>
      {loading && (
        <p role="status" className="mt-2">
          {localize('com_workspace_compare_loading')}
        </p>
      )}
      {failure && (
        <p role="alert" className="mt-2">
          {localize(`com_workspace_compare_${failure}`, { revision })}
        </p>
      )}
      {comparison && (
        <div className="mt-3 min-w-0">
          {stale && (
            <p role="status" className="mb-2">
              {localize('com_workspace_compare_stale')}
            </p>
          )}
          <p>{localize('com_workspace_compare_stored', { revision: comparison.revision })}</p>
          <p className="mb-2">{localize('com_workspace_compare_local')}</p>
          <DiffEditor
            height="180px"
            original={comparison.stored}
            modified={comparison.base.text}
            language={language}
            theme={theme}
            onMount={(editor) => {
              // Monaco's initial reactive option pass clears the construction-time labels.
              editor.getOriginalEditor().updateOptions({
                ariaLabel: localize('com_workspace_compare_stored', {
                  revision: comparison.revision,
                }),
              });
              editor.getModifiedEditor().updateOptions({
                ariaLabel: localize('com_workspace_compare_local'),
              });
            }}
            options={{
              readOnly: true,
              originalEditable: false,
              renderSideBySide: false,
              automaticLayout: true,
              minimap: { enabled: false },
              wordWrap: 'on',
              scrollBeyondLastLine: false,
              originalAriaLabel: localize('com_workspace_compare_stored', {
                revision: comparison.revision,
              }),
              modifiedAriaLabel: localize('com_workspace_compare_local'),
            }}
          />
        </div>
      )}
    </section>
  );
}
