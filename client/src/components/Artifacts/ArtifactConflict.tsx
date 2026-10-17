import { useEffect, useRef, useState } from 'react';
import { Button } from '@librechat/client';
import type { ArtifactRevision } from '~/common/artifacts';
import useLocalize from '~/hooks/useLocalize';
import { DiffEditor } from './monaco';

/** A conflict can only be resolved against an explicitly fetched, displayed revision. */
export function ArtifactConflict({
  draft,
  language,
  theme,
  disabled,
  load,
  onResolve,
}: {
  draft: string;
  language: string;
  theme: string;
  disabled: boolean;
  load: () => Promise<ArtifactRevision>;
  onResolve: (revision: ArtifactRevision, applyDraft: boolean) => void;
}) {
  const localize = useLocalize();
  const [snapshot, setSnapshot] = useState<ArtifactRevision | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const generation = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      generation.current += 1;
    };
  }, []);

  const compare = async () => {
    const request = ++generation.current;
    setSnapshot(null);
    setFailed(false);
    setLoading(true);
    try {
      const value = await load();
      if (alive.current && request === generation.current) setSnapshot(value);
    } catch {
      if (alive.current && request === generation.current) setFailed(true);
    } finally {
      if (alive.current && request === generation.current) setLoading(false);
    }
  };

  return (
    <section
      className="border-border-medium bg-surface-secondary text-text-primary max-h-[55%] shrink-0 overflow-y-auto border-b p-3 text-sm"
      aria-label={localize('com_ui_artifact_conflict_title')}
    >
      <p role="alert">{localize('com_ui_artifact_conflict_message')}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          className="h-auto min-h-10 max-w-full text-left whitespace-normal"
          size="sm"
          variant="outline"
          onClick={compare}
          disabled={disabled || loading}
        >
          {localize('com_ui_artifact_conflict_compare')}
        </Button>
        {loading && <span role="status">{localize('com_ui_loading')}</span>}
      </div>
      {failed && (
        <p role="alert" className="mt-2">
          {localize('com_ui_artifact_conflict_load_error')}
        </p>
      )}
      {snapshot && !loading && (
        <div className="mt-3 min-w-0">
          <p className="mb-2">{localize('com_ui_artifact_conflict_comparison')}</p>
          <DiffEditor
            height="180px"
            original={snapshot.content}
            modified={draft}
            language={language}
            theme={theme}
            options={{
              readOnly: true,
              originalEditable: false,
              renderSideBySide: false,
              automaticLayout: true,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              originalAriaLabel: localize('com_ui_artifact_conflict_saved'),
              modifiedAriaLabel: localize('com_ui_artifact_conflict_draft'),
            }}
          />
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              className="h-auto min-h-10 max-w-full text-left whitespace-normal"
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => onResolve(snapshot, false)}
            >
              {localize('com_ui_artifact_conflict_adopt')}
            </Button>
            <Button
              className="h-auto min-h-10 max-w-full text-left whitespace-normal"
              size="sm"
              disabled={disabled || draft.length === 0}
              onClick={() => onResolve(snapshot, true)}
            >
              {localize('com_ui_artifact_conflict_apply')}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
