import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import type { TranslationKeys } from '~/hooks/useLocalize';
import type { ExtendedFile } from '~/common';
import { changeUpload, abortManagedTransfer } from './api';
import { useManagedUploads } from './useManagedUploads';
import { cancelManagedSelection } from './transfer';
import useLocalize from '~/hooks/useLocalize';
import { uploadPhase } from './progress';

const mib = (bytes: number, locale?: string) =>
  (bytes / 1_048_576).toLocaleString(locale, { maximumFractionDigits: 2 });
const date = (value: string, locale?: string) => new Date(value).toLocaleString(locale);
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
const isSecurityFailure = (error?: string) =>
  error === 'security_rejected' || error === 'security_uninspectable';

export function ManagedUploadPanel() {
  const localize = useLocalize();
  const { i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
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
            <dd>
              {localize('com_upload_size_mib', { 0: mib(uploads.data.usage.usedBytes, locale) })}
            </dd>
          </div>
          <div>
            <dt>{localize('com_upload_reserved')}</dt>
            <dd>
              {localize('com_upload_size_mib', {
                0: mib(uploads.data.usage.reservedBytes, locale),
              })}
            </dd>
          </div>
          <div>
            <dt>{localize('com_upload_available')}</dt>
            <dd>
              {localize('com_upload_size_mib', {
                0: mib(uploads.data.usage.availableBytes, locale),
              })}
            </dd>
          </div>
          <div>
            <dt>{localize('com_upload_retained')}</dt>
            <dd>
              {localize('com_upload_size_mib', {
                0: mib(uploads.data.usage.retainedBytes, locale),
              })}
            </dd>
          </div>
        </dl>
        <p>
          {localize(
            uploads.isGuestAccount
              ? 'com_upload_guest_rolling_explained'
              : 'com_upload_rolling_explained',
          )}
        </p>
        {uploads.isGuestAccount && <p className="mt-1">{localize('com_upload_guest_access')}</p>}
        {uploads.data.usage.nextReleaseAt && (
          <p className="mt-1">
            {localize('com_upload_next_release', {
              0: mib(uploads.data.usage.nextReleaseBytes, locale),
              1: date(uploads.data.usage.nextReleaseAt, locale),
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
    <div className="mb-2 w-full text-sm">
      <p className="text-text-secondary mb-2">{localize('com_upload_security_notice')}</p>
      <details className="border-border-light text-text-secondary w-full rounded-xl border px-3 py-2 text-sm">
        <summary className="cursor-pointer rounded focus-visible:outline focus-visible:outline-2">
          {localize(
            uploads.isGuestAccount
              ? 'com_upload_guest_limits_summary'
              : 'com_upload_limits_summary',
          )}
        </summary>
        {content}
        {uploads.eligible && uploads.data && (
          <>
            {uploads.admissionsPaused !== false && (
              <p role="status" className="mt-2">
                {localize(
                  uploads.admissionsPaused === true
                    ? 'com_upload_admission_paused'
                    : 'com_upload_status_unavailable',
                )}
              </p>
            )}
            {uploads.isError && (
              <p role="alert" className="mt-2">
                {localize('com_upload_refresh_failed')}
              </p>
            )}
          </>
        )}
      </details>
    </div>
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
  const { i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const uploads = useManagedUploads();
  const [pending, setPending] = useState<'cancel' | 'delete' | 'retry' | null>(null);
  const [actionError, setActionError] = useState(false);
  const local = file.managedUpload!;
  const operation =
    uploads.data?.operations.find((row) => row.id === local.operation?.id) ?? local.operation;
  let error = operation?.error ?? local.error;
  // A stale generic snapshot must not replace a concrete local security failure with retry advice.
  if (isSecurityFailure(local.error) && !isSecurityFailure(error)) error = local.error;
  const securityFailure = isSecurityFailure(error);
  const serverProcessingOrTerminal =
    operation && !['waiting', 'transferring'].includes(operation.state);
  const phase = pending
    ? { cancel: 'cancelling', delete: 'deleting', retry: 'retrying' }[pending]
    : uploadPhase(serverProcessingOrTerminal ? operation.state : local.phase, local.transfer);
  const terminal = ['ready', 'failed', 'cancelled', 'deleted', 'expired'].includes(phase);
  const progress = local.transfer;
  let errorKey: TranslationKeys = 'com_upload_action_failed';
  if (error === 'security_rejected') {
    errorKey = 'com_upload_security_rejected';
  } else if (error === 'security_uninspectable') {
    errorKey = 'com_upload_security_uninspectable';
  } else if (error === 'quota_exceeded') {
    errorKey = 'com_upload_quota_exceeded';
  } else if (error === 'queue_full' || error === 'capacity_exceeded') {
    errorKey = 'com_upload_capacity_unavailable';
  } else if (error === 'size_mismatch') {
    errorKey = 'com_upload_size_mismatch';
  } else if (error === 'admission_paused') {
    errorKey = 'com_upload_admission_paused';
  }
  const action = async (kind: 'cancel' | 'delete' | 'retry') => {
    if (pending || !operation || (kind === 'retry' && securityFailure)) return;
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
        {localize(
          securityFailure && !pending
            ? 'com_upload_failed'
            : (phaseKeys[phase] ?? 'com_upload_failed'),
        )}
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
              0: mib(progress.loaded, locale),
              1: mib(progress.total, locale),
              2: progress.percent,
            })}
          </p>
          {progress.bytesPerSecond !== null && (
            <p>
              {progress.remainingSeconds === null
                ? localize('com_upload_transfer_speed', { 0: mib(progress.bytesPerSecond, locale) })
                : localize('com_upload_transfer_speed_remaining', {
                    0: mib(progress.bytesPerSecond, locale),
                    1: localize('com_upload_seconds_left', { 0: progress.remainingSeconds }),
                  })}
            </p>
          )}
        </>
      )}
      {phase === 'storing' && <p>{localize('com_upload_transfer_complete')}</p>}
      {operation?.expiresAt && (
        <p className="text-text-secondary mt-1">
          {localize('com_upload_expires', { 0: date(operation.expiresAt, locale) })}
        </p>
      )}
      {operation?.cleanupPending && (
        <p className="mt-1">{localize('com_upload_cleanup_pending')}</p>
      )}
      {(actionError || error) && (
        <p role="alert" className="mt-1">
          {localize(errorKey)}
        </p>
      )}
      {phase === 'failed' && !operation?.acceptedAt && !securityFailure && (
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
        {operation?.canRetryProcessing && !securityFailure && (
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
