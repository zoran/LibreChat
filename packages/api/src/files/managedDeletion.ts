/** Foreground File revocation hands durable cleanup to HK and only reports observed completion. */
import type { FileOwnerScope, FileCleanupLifecycleMethods } from '@librechat/data-schemas';
import type { FileDeletionWorkScope } from './deletion';

export interface ManagedFileDeletionPorts {
  revokeFileSources(
    owner: FileOwnerScope,
    fileIds: readonly string[],
  ): Promise<{ revokedFileIds: string[] }>;
  revokeFileSourceGenerations(
    owner: FileOwnerScope,
    fileIds: string[],
  ): Promise<{ complete: boolean; pending: readonly unknown[] }>;
  assertFileSourceDeletionReady(owner: FileOwnerScope, fileIds: readonly string[]): Promise<void>;
  observeFileCleanupCompletion: FileCleanupLifecycleMethods['observeCompletion'];
  removeAgentResourceFilesFromAllAgents(input: { file_ids: string[] }): Promise<unknown>;
}

export interface ManagedFileDeletionResult {
  deletedFileIds: string[];
  failedFileIds: string[];
  /** Internal work-settlement classification; never part of the HTTP response. */
  pendingManagedFileIds: string[];
}

export async function requestManagedFileDeletion(
  input: { owner: FileOwnerScope; fileIds: string[]; work: FileDeletionWorkScope },
  ports: ManagedFileDeletionPorts,
): Promise<ManagedFileDeletionResult> {
  const { owner, fileIds, work } = input;
  if (fileIds.length === 0)
    return { deletedFileIds: [], failedFileIds: [], pendingManagedFileIds: [] };
  const revoked = await work.effect(() => ports.revokeFileSources(owner, fileIds));
  if (
    !Array.isArray(revoked?.revokedFileIds) ||
    revoked.revokedFileIds.some((id) => typeof id !== 'string' || !id) ||
    fileIds.some((id) => !revoked.revokedFileIds.includes(id))
  )
    throw new Error('MANAGED_FILE_REVOKE_UNCONFIRMED');
  const ids = [...new Set(revoked.revokedFileIds)];
  // Await the original foreground promise, including provider abort/drain. HK later
  // captures durable generation liabilities under its own claim and File custody.
  const receipt = await work.effect(() => ports.revokeFileSourceGenerations(owner, ids));
  const replayComplete =
    receipt?.complete === true && Array.isArray(receipt.pending) && receipt.pending.length === 0;
  // Retain the existing refusal for unknown inventory/open liabilities, after abort/drain.
  await ports.assertFileSourceDeletionReady(owner, ids);
  const observed = await ports.observeFileCleanupCompletion(owner, ids, {
    deadlineAt: Date.now() + 5000,
    signal: new AbortController().signal,
  });
  const byId = new Map(observed.map((value) => [value.fileId, value]));
  const exact =
    observed.length === ids.length && byId.size === ids.length && ids.every((id) => byId.has(id));
  const complete = exact && replayComplete && ids.every((id) => byId.get(id)?.state === 'complete');
  if (!complete) {
    const knownPending =
      exact && replayComplete && ids.every((id) => byId.get(id)?.state !== 'unknown');
    if (!knownPending) work.markUncertain();
    // A root cannot be reported deleted while any member of its revoked closure is pending.
    return {
      deletedFileIds: [],
      failedFileIds: ids,
      pendingManagedFileIds: knownPending ? ids : [],
    };
  }
  await work.effect(() => ports.removeAgentResourceFilesFromAllAgents({ file_ids: ids }));
  return { deletedFileIds: ids, failedFileIds: [], pendingManagedFileIds: [] };
}
