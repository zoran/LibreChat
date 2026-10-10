/** History owns admitted HTTP work; persistence stays with its existing data owners. */
import type { ApplicationWorkPort } from '~/app';

const operations = [
  'message-branch',
  'message-artifact',
  'message-save',
  'message-edit',
  'message-feedback',
  'message-delete',
  'title-consume',
  'conversation-delete',
  'conversation-delete-all',
  'conversation-archive',
  'conversation-archive-all',
  'conversation-pin',
  'conversation-update',
  'conversation-import',
  'conversation-fork',
  'conversation-duplicate',
] as const;
export type HistoryMutation = (typeof operations)[number];
const supportedOperations = new Set<string>(operations);

export interface HistoryMutationScope {
  /** Register before dispatch. Rejection/absent confirmation remains uncertain. */
  write<T>(action: () => PromiseLike<T> | T, confirm?: (value: T) => boolean): Promise<T>;
  /** Callback owners release only after their actual child callback has run. */
  hold(kind: 'write' | 'continuation'): () => void;
  uncertain(): void;
  finish(): void;
}
export interface HistoryMutationOwner extends ApplicationWorkPort {
  admit(operation: HistoryMutation): HistoryMutationScope | undefined;
}

/** No request/user data or unbounded failure ledger is retained by the census. */
export function createHistoryMutationOwner(): HistoryMutationOwner {
  let paused: string | null = null;
  let unknown = false;
  let pendingWrites = 0;
  let queuedContinuations = 0;
  return {
    pauseAdmissions(id) {
      if (!id || (paused !== null && paused !== id)) return false;
      paused = id;
      return true;
    },
    resumeAdmissions(id) {
      if (paused !== id || unknown) return false;
      paused = null;
      return true;
    },
    async getMaintenanceCensus(id) {
      return {
        admissionClosed: paused !== null,
        queuedContinuations,
        pendingWrites,
        complete: !unknown && id === paused,
      };
    },
    admit(operation) {
      // JavaScript callers have the same closed contract as typed consumers.
      if (!supportedOperations.has(operation)) {
        unknown = true;
        return undefined;
      }
      if (paused !== null) return undefined;
      queuedContinuations++;
      let children = 1;
      let finished = false;
      const uncertain = () => {
        unknown = true;
      };
      const hold: HistoryMutationScope['hold'] = (kind) => {
        // A late callback cannot silently create work after a previously empty census.
        if (children === 0) uncertain();
        children++;
        if (kind === 'write') pendingWrites++;
        else queuedContinuations++;
        let released = false;
        return () => {
          if (released) {
            uncertain();
            return;
          }
          released = true;
          children--;
          if (kind === 'write') pendingWrites--;
          else queuedContinuations--;
        };
      };
      return {
        hold,
        uncertain,
        async write(action, confirm) {
          const release = hold('write');
          try {
            const result = await action();
            if (confirm && !confirm(result)) uncertain();
            return result;
          } catch (error) {
            uncertain();
            throw error;
          } finally {
            release();
          }
        },
        finish() {
          if (finished) {
            uncertain();
            return;
          }
          finished = true;
          children--;
          queuedContinuations--;
        },
      };
    },
  };
}

/** saveConvo preserves its legacy error result; callers must not mistake it for a commit. */
export function isHistoryConversationResult(value: unknown): boolean {
  return (
    value === null ||
    (typeof value === 'object' &&
      value !== null &&
      (value as { message?: string }).message !== 'Error saving conversation')
  );
}
export function isHistoryMessageResult(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { messageId?: unknown }).messageId === 'string'
  );
}
export function isHistoryDeleteResult(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { acknowledged?: unknown }).acknowledged === true
  );
}
