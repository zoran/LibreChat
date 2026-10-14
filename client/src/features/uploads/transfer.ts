import type { ManagedUploadView, UploadOperation } from 'librechat-data-provider';
import type { TransferProgress } from './progress';
import type { ExtendedFile } from '~/common';
import { reserveUpload, sendUploadBody, changeUpload, UploadRequestError } from './api';

const selected = new Map<string, AbortController>();
export const cancelManagedSelection = (id: string) => selected.get(id)?.abort();

type SelectionOptions = {
  signal: AbortSignal;
  current: () => boolean;
  update: (id: string, patch: Partial<ExtendedFile>) => void;
  refresh: () => Promise<unknown>;
  ready: (id: string, signal: AbortSignal) => Promise<ManagedUploadView>;
  onStart?: (id: string) => void;
  onSuccess?: (id: string) => void;
  onError?: (id: string) => void;
  onAbort?: (id: string) => void;
};

/** One bounded selection queue. A failed body is never silently replayed. */
export async function runManagedSelection(files: ExtendedFile[], options: SelectionOptions) {
  const controls = files.map((file) => {
    const controller = new AbortController();
    selected.set(file.file_id, controller);
    return controller;
  });
  const abort = () => controls.forEach((controller) => controller.abort());
  options.signal.addEventListener('abort', abort, { once: true });
  if (options.signal.aborted) abort();
  try {
    for (let index = 0; index < files.length; index++) {
      if (!options.current()) break;
      const file = files[index];
      const signal = controls[index].signal;
      let operation: UploadOperation | undefined;
      let transfer: TransferProgress | undefined;
      const update = (phase: string, error?: string) => {
        if (!options.current()) return;
        options.update(file.file_id, {
          progress: transfer ? transfer.loaded / transfer.total : 0,
          managedUpload: { operation, phase, transfer, error },
        });
      };
      const assertCurrent = () => {
        if (signal.aborted || !options.current()) throw new DOMException('Aborted', 'AbortError');
      };
      try {
        assertCurrent();
        options.onStart?.(file.file_id);
        update('waiting');
        operation = await reserveUpload(
          {
            filename: file.filename!,
            mediaType: file.type!,
            declaredBytes: file.size,
            idempotencyKey: file.file_id,
            scope: { kind: 'personal' },
          },
          signal,
        );
        assertCurrent();
        update('waiting');
        operation = await sendUploadBody(operation.id, file.file!, signal, (value) => {
          transfer = value;
          if (value.loaded >= value.total) update('storing');
          else if (value.loaded > 0) update('transferring');
          else update('waiting');
        });
        assertCurrent();
        update(operation.state);
        await options.refresh();
        assertCurrent();
        const ready = await options.ready(operation.id, signal);
        assertCurrent();
        options.update(file.file_id, {
          ...ready.attachment,
          file_id: ready.attachment!.file_id,
          temp_file_id: file.file_id,
          size: ready.attachment!.bytes,
          progress: 1,
          managedUpload: { operation: ready, phase: 'ready', transfer },
        });
        options.onSuccess?.(file.file_id);
      } catch (error) {
        // Never make a late authenticated request under a replacement account.
        if (!options.current()) break;
        const aborted = signal.aborted;
        if (aborted && operation) await changeUpload(operation.id, 'cancel').catch(() => undefined);
        if (!options.current()) break;
        if (aborted) {
          update('cancelled');
          options.onAbort?.(file.file_id);
        } else {
          update('failed', error instanceof UploadRequestError ? error.code : 'unavailable');
          options.onError?.(file.file_id);
        }
        void options.refresh().catch(() => undefined);
      } finally {
        selected.delete(file.file_id);
      }
    }
  } finally {
    options.signal.removeEventListener('abort', abort);
    files.forEach((file) => selected.delete(file.file_id));
    abort();
  }
}
