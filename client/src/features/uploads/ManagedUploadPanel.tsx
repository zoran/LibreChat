import { useState } from 'react';
import type { ReactNode } from 'react';
import type { TranslationKeys } from '~/hooks/useLocalize';
import type { ExtendedFile } from '~/common';
import { changeUpload, abortManagedTransfer } from './api';
import { useManagedUploads } from './useManagedUploads';
import { cancelManagedSelection } from './transfer';
import useLocalize from '~/hooks/useLocalize';
import { uploadPhase } from './progress';

const mib = (bytes: number) =>
  (bytes / 1_048_576).toLocaleString(undefined, { maximumFractionDigits: 2 });
const date = (value: string) => new Date(value).toLocaleString();
const phaseKeys: Record<string, TranslationKeys> = {
  selected: 'com_upload_selected',
  waiting: 'com_upload_waiting',
  transferring: 'com_upload_transferring',
  storing: 'com_upload_storing',
  queued_processing: 'com_upload_queued_processing',
  processing: 'com_upload_processing',
  deleting: 'com_upload_deleting',
  retrying: 'com_upload_retrying',
  ready: 'com_upload_ready',
  cancelling: 'com_upload_cancelling',
  cancelled: 'com_upload_cancelled',
  failed: 'com_upload_failed',
  deleted: 'com_upload_deleted',
  expired: 'com_upload_expired',
};
const actionClass =
  'rounded px-2 py-1 text-sm underline underline-offset-2 focus-visible:outline focus-visible:outline-2 disabled:opacity-50';

export function ManagedUploadPanel() {
  const localize = useLocalize();
  const uploads = useManagedUploads();
  if (!uploads.enabled) return null;
  let content: ReactNode;
  if (!uploads.eligible) {
    content = <p className="mt-2">{localize('com_upload_login_needed')}</p>;
  } else if (uploads.data) {
    content = (
      <>
        <dl className="my-2 grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-4">
          <div>
            <dt>{localize('com_upload_used')}</dt>
            <dd>{localize('com_upload_size_mib', { 0: mib(uploads.data.usage.usedBytes) })}</dd>
          </div>
          <div>
            <dt>{localize('com_upload_reserved')}</dt>
            <dd>{localize('com_upload_size_mib', { 0: mib(uploads.data.usage.reservedBytes) })}</dd>
          </div>
          <div>
            <dt>{localize('com_upload_available')}</dt>
            <dd>
              {localize('com_upload_size_mib', { 0: mib(uploads.data.usage.availableBytes) })}
            </dd>
          </div>
          <div>
            <dt>{localize('com_upload_retained')}</dt>
            <dd>{localize('com_upload_size_mib', { 0: mib(uploads.data.usage.retainedBytes) })}</dd>
          </div>
        </dl>
        <p>{localize('com_upload_rolling_explained')}</p>
        {uploads.data.usage.nextReleaseAt && (
          <p className="mt-1">
            {localize('com_upload_next_release', {
              0: mib(uploads.data.usage.nextReleaseBytes),
              1: date(uploads.data.usage.nextReleaseAt),
            })}
          </p>
        )}
        <p className="mt-1">{localize('com_upload_delete_explained')}</p>
        {uploads.data.throttled && (
          <p role="status" className="mt-2">
            {localize('com_upload_throttled')}
          </p>
        )}
      </>
    );
  } else {
    content = (
      <p className="mt-2" role="status">
        {localize(uploads.isError ? 'com_upload_status_unavailable' : 'com_upload_loading')}
      </p>
    );
  }
  return (
    <details className="border-border-light text-text-secondary mb-2 w-full rounded-xl border px-3 py-2 text-sm">
      <summary className="cursor-pointer rounded focus-visible:outline focus-visible:outline-2">
        {localize('com_upload_limits_summary')}
      </summary>
      {content}
    </details>
  );
}

export function ManagedUploadCard({
  file,
  onRemove,
}: {
  file: ExtendedFile;
  onRemove: () => void;
}) {
  const localize = useLocalize();
  const uploads = useManagedUploads();
  const [pending, setPending] = useState<'cancel' | 'delete' | 'retry' | null>(null);
  const [actionError, setActionError] = useState(false);
  const local = file.managedUpload!;
  const operation =
    uploads.data?.operations.find((row) => row.id === local.operation?.id) ?? local.operation;
  const serverProcessingOrTerminal =
    operation && !['waiting', 'transferring'].includes(operation.state);
  const phase = pending
    ? { cancel: 'cancelling', delete: 'deleting', retry: 'retrying' }[pending]
    : uploadPhase(serverProcessingOrTerminal ? operation.state : local.phase, local.transfer);
  const terminal = ['ready', 'failed', 'cancelled', 'deleted', 'expired'].includes(phase);
  const progress = local.transfer;
  let errorKey: TranslationKeys = 'com_upload_action_failed';
  if (local.error === 'quota_exceeded') {
    errorKey = 'com_upload_quota_exceeded';
  } else if (local.error === 'queue_full' || local.error === 'capacity_exceeded') {
    errorKey = 'com_upload_capacity_unavailable';
  } else if (local.error === 'size_mismatch') {
    errorKey = 'com_upload_size_mismatch';
  }
  const action = async (kind: 'cancel' | 'delete' | 'retry') => {
    if (pending || !operation) return;
    setPending(kind);
    setActionError(false);
    try {
      if (kind === 'cancel') {
        cancelManagedSelection(file.temp_file_id ?? file.file_id);
        abortManagedTransfer(operation.id);
      }
      await changeUpload(operation.id, kind);
      await uploads.refresh();
      if (kind === 'delete') onRemove();
    } catch {
      setActionError(true);
    } finally {
      setPending(null);
    }
  };
  return (
    <div className="border-border-light bg-surface-hover-alt w-full max-w-sm rounded-xl border p-3 text-sm">
      <p className="text-text-primary truncate font-medium" title={file.filename}>
        {file.filename}
      </p>
      <p role="status" aria-live="polite" aria-atomic="true" className="text-text-secondary">
        {localize(phaseKeys[phase] ?? 'com_upload_failed')}
      </p>
      {phase === 'transferring' && progress && (
        <>
          <progress
            className="mt-2 h-2 w-full"
            value={progress.loaded}
            max={progress.total}
            aria-label={localize('com_upload_transferring')}
          />
          <p>
            {localize('com_upload_transfer_progress', {
              0: mib(progress.loaded),
              1: mib(progress.total),
              2: progress.percent,
            })}
          </p>
          {progress.bytesPerSecond !== null && (
            <p>
              {progress.remainingSeconds === null
                ? localize('com_upload_transfer_speed', { 0: mib(progress.bytesPerSecond) })
                : localize('com_upload_transfer_speed_remaining', {
                    0: mib(progress.bytesPerSecond),
                    1: localize('com_upload_seconds_left', { 0: progress.remainingSeconds }),
                  })}
            </p>
          )}
        </>
      )}
      {phase === 'storing' && <p>{localize('com_upload_transfer_complete')}</p>}
      {operation?.expiresAt && (
        <p className="text-text-secondary mt-1">
          {localize('com_upload_expires', { 0: date(operation.expiresAt) })}
        </p>
      )}
      {operation?.cleanupPending && (
        <p className="mt-1">{localize('com_upload_cleanup_pending')}</p>
      )}
      {(actionError || local.error) && (
        <p role="alert" className="mt-1">
          {localize(errorKey)}
        </p>
      )}
      {phase === 'failed' && !operation?.acceptedAt && (
        <p>{localize('com_upload_retry_from_start')}</p>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        {!terminal && operation && (
          <button
            type="button"
            className={actionClass}
            disabled={pending !== null}
            onClick={() => void action('cancel')}
          >
            {localize('com_upload_cancel')}
          </button>
        )}
        {operation?.canRetryProcessing && (
          <button
            type="button"
            className={actionClass}
            disabled={pending !== null}
            onClick={() => void action('retry')}
          >
            {localize('com_upload_retry_processing')}
          </button>
        )}
        {(terminal || !operation) && (
          <button
            type="button"
            className={actionClass}
            onClick={() => {
              cancelManagedSelection(file.temp_file_id ?? file.file_id);
              onRemove();
            }}
          >
            {localize('com_upload_remove')}
          </button>
        )}
        {operation?.acceptedAt && !['deleted', 'expired'].includes(phase) && (
          <button
            type="button"
            className={actionClass}
            disabled={pending !== null}
            onClick={() => void action('delete')}
          >
            {localize('com_upload_delete')}
          </button>
        )}
      </div>
    </div>
  );
}
