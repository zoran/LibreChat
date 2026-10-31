/** Bounded scanner joins; interruption and transport failure never attest cleanup. */
import {
  readUploadSecuritySettlement,
  isCompleteUploadSecuritySettlement,
  readHistoricalUploadSecuritySettlement,
  isCompleteHistoricalUploadSecuritySettlement,
} from 'librechat-data-provider';
import type { UploadSecurityExecution, UploadSecuritySettlement } from 'librechat-data-provider';
import type { UploadSecurityPort } from '../contract';

export async function waitForSecurityResponse<T>(
  work: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error('Security operation interrupted'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return work();
      }),
      interrupted,
    ]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

/** Preserve the worker's existing abort error while sharing the same bounded join implementation. */
export async function waitForSecurityWorker<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  try {
    return await waitForSecurityResponse(() => promise, signal);
  } catch (error) {
    if (signal.aborted) throw new Error('Security worker unavailable');
    throw error;
  }
}

export async function cancelSecurityExecution(
  port: UploadSecurityPort | undefined,
  execution: UploadSecurityExecution,
  signal: AbortSignal,
): Promise<UploadSecuritySettlement | null> {
  try {
    if (!port) return null;
    const result = await waitForSecurityResponse(() => port.cancel({ execution, signal }), signal);
    const settlement = readUploadSecuritySettlement(result);
    return isCompleteUploadSecuritySettlement(settlement, execution) ? settlement : null;
  } catch {
    return null;
  }
}

/** Only retained cleanup may consume an authentic matching retirement of its original protocol. */
export async function cancelHistoricalSecurityExecution(
  port: UploadSecurityPort | undefined,
  execution: UploadSecurityExecution,
  signal: AbortSignal,
): Promise<UploadSecuritySettlement | null> {
  try {
    if (!port) return null;
    const result = await waitForSecurityResponse(() => port.cancel({ execution, signal }), signal);
    const settlement = readHistoricalUploadSecuritySettlement(result);
    return isCompleteHistoricalUploadSecuritySettlement(settlement, execution) ? settlement : null;
  } catch {
    return null;
  }
}
