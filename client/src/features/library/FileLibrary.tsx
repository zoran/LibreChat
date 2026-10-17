/** Personal catalog composition; native File owns originals, access, previews and deletion. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useRecoilValue } from 'recoil';
import { Button } from '@librechat/client';
import { FileSources } from 'librechat-data-provider';
import type { FileLibraryItem, FileLibraryQuery, FileLibraryUpdate } from 'librechat-data-provider';
import { useDeleteFilesMutation } from '~/data-provider/Files/mutations';
import useLocalize from '~/hooks/useLocalize';
import type { TranslationKeys } from '~/hooks/useLocalize';
import store from '~/store';
import { getSessionPrincipal } from '~/utils/session';
import { FileLibraryRequestError, updateFileLibrary } from './api';
import { fileLibraryKey, useFileLibrary } from './useFileLibrary';
import { LibraryFilters } from './LibraryFilters';
import { LibraryTable } from './LibraryTable';
import { LibraryTagEditor } from './LibraryTagEditor';

/** Host actions receive only current authorized rows; clear only individually confirmed outcomes. */
export type FileLibrarySelection = {
  files: readonly FileLibraryItem[];
  disabled: boolean;
  clearSelection: (ids: readonly string[]) => void;
};

type LibraryProps = {
  projectId?: string;
  renderSelectionActions?: (selection: FileLibrarySelection) => ReactNode;
};

/** A project filter means existing native membership, never permission to add a source. */
export function FileLibrary({ projectId, renderSelectionActions }: LibraryProps) {
  const user = useRecoilValue(store.user);
  const enabled = useRecoilValue(store.queriesEnabled);
  const localize = useLocalize();
  if (!enabled || !user?.id) return <p role="status">{localize('com_ui_loading')}</p>;
  return (
    <LibrarySession
      key={JSON.stringify([user.id, user.tenantId ?? null, projectId ?? null])}
      ownerId={user.id}
      tenantId={user.tenantId ?? null}
      projectId={projectId}
      renderSelectionActions={renderSelectionActions}
    />
  );
}

function LibrarySession({
  ownerId,
  tenantId,
  projectId,
  renderSelectionActions,
}: {
  ownerId: string;
  tenantId: string | null;
  projectId?: string;
  renderSelectionActions?: LibraryProps['renderSelectionActions'];
}) {
  const queryClient = useQueryClient();
  const localize = useLocalize();
  const principal = useRef(getSessionPrincipal()).current;
  const ended = useRef(false);
  const [sessionEnded, setSessionEnded] = useState(false);
  const isCurrent = useCallback(
    () => !ended.current && getSessionPrincipal() === principal,
    [principal],
  );
  useEffect(() => {
    const end = () => {
      ended.current = true;
      setSessionEnded(true);
      void queryClient.cancelQueries(fileLibraryKey(ownerId, tenantId));
    };
    window.addEventListener('librechat:auth-session-ending', end);
    return () => window.removeEventListener('librechat:auth-session-ending', end);
  }, [ownerId, tenantId, queryClient]);
  const [filters, setFilters] = useState<FileLibraryQuery>({ limit: 25, archive: 'active' });
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const cursor = cursors[cursors.length - 1];
  const query: FileLibraryQuery = {
    ...filters,
    ...(projectId ? { projectId } : {}),
    ...(cursor ? { cursor } : {}),
  };
  const result = useFileLibrary(ownerId, tenantId, query, isCurrent);
  const [busy, setBusy] = useState(false);
  if (sessionEnded) return <p role="status">{localize('com_ui_loading')}</p>;
  return (
    <div className="flex min-h-0 flex-col gap-4">
      <LibraryFilters
        disabled={busy}
        onApply={(value) => {
          setFilters(value);
          setCursors([undefined]);
        }}
      />
      <LibraryPage
        key={JSON.stringify(query)}
        result={result}
        busy={busy}
        setBusy={setBusy}
        isCurrent={isCurrent}
        renderSelectionActions={renderSelectionActions}
        page={cursors.length}
        onPrevious={() => setCursors((value) => value.slice(0, -1))}
        onNext={(next) => setCursors((value) => [...value, next])}
      />
    </div>
  );
}

function LibraryPage({
  result,
  busy,
  setBusy,
  page,
  onPrevious,
  onNext,
  isCurrent,
  renderSelectionActions,
}: {
  result: ReturnType<typeof useFileLibrary>;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  page: number;
  onPrevious: () => void;
  onNext: (cursor: string) => void;
  isCurrent: () => boolean;
  renderSelectionActions?: LibraryProps['renderSelectionActions'];
}) {
  const localize = useLocalize();
  const deletion = useDeleteFilesMutation({ silent: true });
  const lifetime = useRef(new AbortController());
  const [selected, setSelected] = useState(new Set<string>());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [notice, setNotice] = useState<TranslationKeys | null>(null);
  const [sessionStale, setSessionStale] = useState(false);
  const loading =
    result.isFetching ||
    result.isLoading ||
    !result.isFetchedAfterMount ||
    sessionStale ||
    !isCurrent();
  const unavailable = loading || result.isError;
  const files = unavailable ? [] : (result.data?.files ?? []);
  const selectedFiles = files.filter((file) => selected.has(file.file_id));
  const editingFile = result.data?.files.find((file) => file.file_id === editingId);

  useEffect(() => {
    if (lifetime.current.signal.aborted) lifetime.current = new AbortController();
    const controller = lifetime.current;
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (unavailable) return;
    const present = new Set(result.data?.files.map((file) => file.file_id));
    setSelected((previous) => new Set([...previous].filter((id) => present.has(id))));
  }, [result.data, unavailable]);

  async function run(task: (signal: AbortSignal) => Promise<void>) {
    if (!isCurrent()) {
      setSessionStale(true);
      return;
    }
    if (busy || unavailable || lifetime.current.signal.aborted) return;
    const signal = lifetime.current.signal;
    setBusy(true);
    setNotice(null);
    setConfirmDelete(false);
    try {
      await task(signal);
    } catch (error) {
      if (signal.aborted || !isCurrent()) return;
      setNotice(
        error instanceof FileLibraryRequestError && error.status === 409
          ? 'com_library_conflict'
          : 'com_library_action_uncertain',
      );
    } finally {
      if (!signal.aborted && !isCurrent()) setSessionStale(true);
      if (!signal.aborted && isCurrent()) {
        await result.refetch();
        if (!signal.aborted && isCurrent()) setBusy(false);
      }
    }
  }

  async function archive(archived: boolean) {
    const targets = selectedFiles.filter((file) => Boolean(file.library.archivedAt) !== archived);
    await run(async (signal) => {
      let failed = false;
      for (const file of targets) {
        signal.throwIfAborted();
        if (!isCurrent()) return;
        try {
          await updateFileLibrary(
            file.file_id,
            { expectedRevision: file.library.revision, archived },
            signal,
          );
          if (signal.aborted || !isCurrent()) return;
          setSelected((previous) => {
            const next = new Set(previous);
            next.delete(file.file_id);
            return next;
          });
        } catch (error) {
          if (signal.aborted || !isCurrent()) return;
          if (!(error instanceof FileLibraryRequestError) || error.status !== 409) throw error;
          failed = true;
        }
      }
      setNotice(failed ? 'com_library_conflict' : 'com_library_saved');
    });
  }

  function saveTags(file: FileLibraryItem, update: FileLibraryUpdate) {
    setConflict(false);
    void run(async (signal) => {
      try {
        await updateFileLibrary(file.file_id, update, signal);
        if (signal.aborted || !isCurrent()) return;
        setEditingId(null);
        setConflict(false);
        setNotice('com_library_saved');
      } catch (error) {
        if (signal.aborted || !isCurrent()) return;
        if (error instanceof FileLibraryRequestError && error.status === 409) setConflict(true);
        throw error;
      }
    });
  }

  function deleteSelected() {
    const targets = selectedFiles;
    void run(async (signal) => {
      let hasFailures = false;
      // The native Cortex delete route admits at most ten originals per request.
      for (let offset = 0; offset < targets.length; offset += 10) {
        signal.throwIfAborted();
        if (!isCurrent()) return;
        const batch = targets.slice(offset, offset + 10);
        const response = await deletion.mutateAsync({
          files: batch.map((file) => ({
            file_id: file.file_id,
            filepath: file.filepath,
            source: file.source ?? FileSources.local,
            embedded: file.embedded,
          })),
        });
        if (signal.aborted || !isCurrent()) return;
        const failed = new Set(response.failedFileIds ?? []);
        hasFailures ||= failed.size > 0;
        setSelected((previous) => {
          const next = new Set(previous);
          batch.forEach((file) => {
            if (!failed.has(file.file_id)) next.delete(file.file_id);
          });
          return next;
        });
      }
      setNotice(hasFailures ? 'com_ui_delete_partial_failure' : 'com_ui_delete_success');
    });
  }

  return (
    <>
      <p className="text-text-secondary text-sm">{localize('com_library_organization_help')}</p>
      {notice && (
        <p role="status" className="text-sm">
          {localize(notice)}
        </p>
      )}
      {busy && !result.isFetching && <p role="status">{localize('com_library_saving')}</p>}
      {loading && (
        <p role="status" className="py-6">
          {localize('com_ui_loading')}
        </p>
      )}
      {!loading && result.isError && (
        <div className="space-y-3 py-6">
          <p role="alert">{localize('com_ui_table_error_description')}</p>
          <Button variant="outline" onClick={() => void result.refetch()}>
            {localize('com_ui_retry')}
          </Button>
        </div>
      )}
      <div hidden={unavailable} className="space-y-3">
        {renderSelectionActions?.({
          files: selectedFiles,
          disabled: busy || unavailable,
          clearSelection: (ids) =>
            setSelected((previous) => {
              const next = new Set(previous);
              ids.forEach((id) => next.delete(id));
              return next;
            }),
        })}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            disabled={busy || selectedFiles.length !== 1}
            onClick={() => {
              setEditingId(selectedFiles[0].file_id);
              setConflict(false);
            }}
          >
            {localize('com_library_edit_tags')}
          </Button>
          <Button
            variant="outline"
            disabled={busy || !selectedFiles.some((file) => !file.library.archivedAt)}
            onClick={() => void archive(true)}
          >
            {localize('com_library_archive')}
          </Button>
          <Button
            variant="outline"
            disabled={busy || !selectedFiles.some((file) => file.library.archivedAt)}
            onClick={() => void archive(false)}
          >
            {localize('com_library_restore')}
          </Button>
          <Button
            variant="outline"
            disabled={busy || !selectedFiles.length}
            onClick={() => setConfirmDelete(true)}
          >
            {localize('com_ui_delete')}
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => void result.refetch()}>
            {localize('com_library_refresh')}
          </Button>
        </div>
        {confirmDelete && (
          <div className="border-border-light space-y-2 rounded-md border p-3">
            <p>{localize('com_library_delete_confirm', { 0: selectedFiles.length })}</p>
            <div className="flex gap-2">
              <Button disabled={busy || !selectedFiles.length} onClick={deleteSelected}>
                {localize('com_library_delete_originals')}
              </Button>
              <Button variant="outline" onClick={() => setConfirmDelete(false)}>
                {localize('com_ui_cancel')}
              </Button>
            </div>
          </div>
        )}
        {editingFile && (
          <LibraryTagEditor
            key={editingFile.file_id}
            file={editingFile}
            busy={busy}
            conflict={conflict}
            onSave={(update) => saveTags(editingFile, update)}
            onClose={() => setEditingId(null)}
          />
        )}
        <LibraryTable
          files={files}
          selected={selected}
          onSelectionChange={(ids) => {
            setSelected(ids);
            setConfirmDelete(false);
          }}
          disabled={busy}
        />
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span>
            {localize('com_library_selected_page', { 0: selectedFiles.length, 1: files.length })}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="outline" disabled={busy || page <= 1} onClick={onPrevious}>
              {localize('com_library_previous')}
            </Button>
            <span>{localize('com_library_page', { 0: page })}</span>
            <Button
              variant="outline"
              disabled={busy || !result.data?.nextCursor}
              onClick={() => {
                if (result.data?.nextCursor) onNext(result.data.nextCursor);
              }}
            >
              {localize('com_library_next')}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}
