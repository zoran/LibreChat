/** Tag drafts survive a revision conflict; retry requires reviewing the fresh server version. */
import { useId, useState } from 'react';
import { Button } from '@librechat/client';
import { readFileLibraryUpdate } from 'librechat-data-provider';
import type { FileLibraryItem, FileLibraryUpdate } from 'librechat-data-provider';
import useLocalize from '~/hooks/useLocalize';

export function LibraryTagEditor({
  file,
  busy,
  conflict,
  onSave,
  onClose,
}: {
  file: FileLibraryItem;
  busy: boolean;
  conflict: boolean;
  onSave: (update: FileLibraryUpdate) => void;
  onClose: () => void;
}) {
  const localize = useLocalize();
  const id = useId();
  const [draft, setDraft] = useState(file.library.tags.join('\n'));
  const [revision, setRevision] = useState(file.library.revision);
  const [invalid, setInvalid] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const needsReview = conflict && (!reviewed || revision !== file.library.revision);
  return (
    <form
      className="border-border-light space-y-3 rounded-md border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        const update = readFileLibraryUpdate({
          expectedRevision: revision,
          tags: draft
            .split('\n')
            .map((tag) => tag.trim())
            .filter(Boolean),
        });
        setInvalid(!update);
        if (update && !needsReview) {
          setReviewed(false);
          onSave(update);
        }
      }}
    >
      <label htmlFor={id} className="block text-sm font-medium break-words">
        {localize('com_library_edit_tags_for', { 0: file.filename })}
      </label>
      <p id={`${id}-help`} className="text-text-secondary text-sm">
        {localize('com_library_tags_help')}
      </p>
      <textarea
        id={id}
        aria-describedby={`${id}-help`}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        disabled={busy}
        rows={3}
        className="border-border-light bg-surface-dialog w-full rounded-md border p-2 text-sm"
      />
      {invalid && (
        <p role="alert" className="text-sm">
          {localize('com_library_tags_invalid')}
        </p>
      )}
      {needsReview && (
        <div className="space-y-2 text-sm">
          <p role="alert">{localize('com_library_tags_conflict')}</p>
          <p>{localize('com_library_current_tags', { 0: file.library.tags.join(', ') || '—' })}</p>
          <Button
            type="button"
            variant="outline"
            disabled={busy || revision === file.library.revision}
            onClick={() => {
              setRevision(file.library.revision);
              setReviewed(true);
            }}
          >
            {localize('com_library_reviewed')}
          </Button>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy || needsReview}>
          {localize('com_ui_save')}
        </Button>
        <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
          {localize('com_ui_cancel')}
        </Button>
      </div>
    </form>
  );
}
