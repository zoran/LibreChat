/** One explicit user action owns one finite server-issued read identity, including network retries. */
import { dataService, isManagedFileReadTicket, QueryKeys } from 'librechat-data-provider';
import type { ManagedFileReadTicket, ManagedFileReadRepresentation } from 'librechat-data-provider';
import type { QueryClient } from '@tanstack/react-query';

export type ManagedFileReadAction = {
  ticket?: ManagedFileReadTicket;
  completed: boolean;
  admitted: boolean;
  scope?: string;
  started?: number;
  pending?: Promise<unknown>;
};
export const createManagedFileReadAction = (): ManagedFileReadAction => ({
  completed: false,
  admitted: false,
});
const clock = () => performance.now();
const unavailable = () => new Error('Managed File read unavailable; reopen to start another read');
const pause = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const done = () => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(unavailable());
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });

export async function readManagedFile<T>(
  action: ManagedFileReadAction,
  input: {
    userId: string;
    tenantId?: string | null;
    fileId: string;
    representation: ManagedFileReadRepresentation;
    signal?: AbortSignal;
    read(options: {
      ticket: ManagedFileReadTicket;
      timeoutMs: number;
      signal?: AbortSignal;
    }): Promise<T>;
  },
): Promise<T> {
  const scope = JSON.stringify([
    input.tenantId ?? null,
    input.userId,
    input.fileId,
    input.representation,
  ]);
  if (action.scope && action.scope !== scope) throw unavailable();
  action.scope = scope;
  if (action.pending) return action.pending as Promise<T>;
  action.started ??= clock();
  const remaining = () => {
    if (input.signal?.aborted) throw unavailable();
    const value = Math.min(
      120_000 - (clock() - action.started!),
      action.ticket ? Date.parse(action.ticket.notAfter) - Date.now() : 120_000,
    );
    if (value <= 0) throw unavailable();
    return value;
  };
  const run = async () => {
    if (!action.ticket) {
      if (action.admitted) throw unavailable();
      action.admitted = true;
      const ticket = await dataService.getManagedFileReadTicket(
        input.userId,
        input.fileId,
        input.representation,
        { signal: input.signal, timeoutMs: remaining() },
      );
      if (
        !isManagedFileReadTicket(ticket) ||
        ticket.fileId !== input.fileId ||
        ticket.representation !== input.representation
      )
        throw unavailable();
      action.ticket = ticket;
    }
    const options = () => ({
      ticket: action.ticket!,
      signal: input.signal,
      timeoutMs: remaining(),
    });
    for (;;) {
      try {
        const result = await input.read(options());
        action.completed = true;
        return result;
      } catch (error) {
        remaining();
        const status = (error as { response?: { status?: number } })?.response?.status;
        if (status && status < 500 && status !== 409) throw error;
        for (;;) {
          let outcome: Awaited<ReturnType<typeof dataService.inspectManagedFileRead>>;
          try {
            outcome = await dataService.inspectManagedFileRead(input.userId, options());
          } catch (inspectionError) {
            const inspectionStatus = (inspectionError as { response?: { status?: number } })
              ?.response?.status;
            if (inspectionStatus && inspectionStatus < 500) throw inspectionError;
            outcome = 'unknown';
          }
          if (outcome === 'expired' || outcome === 'not_found') throw unavailable();
          await pause(Math.min(1_000, remaining()), input.signal);
          if (outcome !== 'unknown') break;
        }
      }
    }
  };
  // Axios errors carry request headers. Keep opaque read identities out of query logs and UI errors.
  action.pending = run()
    .catch(() => {
      throw unavailable();
    })
    .finally(() => {
      action.pending = undefined;
    });
  return action.pending as Promise<T>;
}

/** Completion changes File-owned retention; pre-completion download metadata is not authoritative. */
export async function refreshManagedFileProjection(
  client: QueryClient,
  fileId: string,
): Promise<void> {
  await Promise.all([
    client.invalidateQueries([QueryKeys.files]),
    client.invalidateQueries(['managed-uploads']),
    client.invalidateQueries([QueryKeys.filePreview, fileId], { refetchType: 'none' }),
  ]);
}
