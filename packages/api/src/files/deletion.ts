import type { DeleteFilesResponse } from 'librechat-data-provider';
import type { ApplicationWorkPort } from '~/app/maintenance';

/** What a delete pass reports back about the records it was given. */
export type FileDeletionOutcome = {
  deletedFileIds?: string[];
  failedFileIds?: string[];
};

/** The `{ tool_resource, file_id }` pair an agent resource unlink takes. */
export type AgentResourceFileRef = {
  tool_resource: string;
  file_id: string;
};

/**
 * One requested file, as this module needs to see it: an id, an owner already normalized to a
 * plain string by the caller, and the opaque record the delete pass will be handed. Ownership
 * arrives as a string so no storage type crosses into this package.
 */
export type AgentResourceFileInput<TFile> = {
  file_id: string;
  owner: string | null;
  file: TFile;
};

export type AgentResourceDeletion<TFile> = {
  /** Attached files the caller owns: candidates for storage, vector and metadata deletion. */
  ownedFiles: Array<AgentResourceFileInput<TFile>>;
  /** Attached files owned by someone else, or with no metadata left: unlink the association only. */
  unlinkOnlyFiles: AgentResourceFileRef[];
};

export type AgentResourceDeletionDeps<TFile> = {
  /** Which of these ids another agent still references; a shared file is never destroyed. */
  getSharedResourceFileIds: (params: {
    file_ids: string[];
    excludeAgentObjectId: string;
    excludeToolResource: string;
  }) => Promise<string[]>;
  removeAgentResourceFiles: (params: {
    agent_id: string;
    files: AgentResourceFileRef[];
  }) => Promise<unknown>;
  /** The full delete pass, injected: storage, vectors, metadata, and the unlink of what it deleted. */
  deleteFiles: (files: TFile[]) => Promise<FileDeletionOutcome>;
};

export type AgentResourceDeletionResult = {
  /** `null` when nothing was destroyed, so the caller answers with the unlink message. */
  outcome: FileDeletionOutcome | null;
  unlinkedFileIds: string[];
  destroyedFileIds: string[];
};

export const PARTIAL_FILE_DELETION_MESSAGE = 'Some files could not be deleted';

/**
 * Shapes the body of a delete response. A record whose storage delete failed is not an error for
 * the request as a whole, so the outcome travels in the body rather than the status: clients read
 * `failedFileIds` to know what is still on disk, and treat everything else they asked for as gone.
 */
export const buildDeleteFilesResponse = (
  result: FileDeletionOutcome | null | undefined,
  successMessage: string,
): DeleteFilesResponse => {
  const deletedFileIds = result?.deletedFileIds ?? [];
  const failedFileIds = result?.failedFileIds ?? [];
  return {
    message: failedFileIds.length > 0 ? PARTIAL_FILE_DELETION_MESSAGE : successMessage,
    deletedFileIds,
    failedFileIds,
  };
};

/**
 * Splits the files a delete request names for one agent tool resource into the ones whose storage
 * and embeddings may go with the unlink, and the ones only the association can be removed for.
 *
 * A file the caller owns is theirs to destroy, so it becomes a candidate for the full delete pass;
 * a file that belongs to another user, or that no longer has a metadata record, keeps its bytes and
 * its chunks and loses only its link to the agent. A file the request names but the tool resource
 * does not hold appears in neither list.
 */
export const partitionAgentResourceFiles = <TFile>({
  requestedFileIds,
  attachedFileIds,
  files,
  toolResource,
  userId,
}: {
  requestedFileIds: string[];
  attachedFileIds: string[];
  files: Array<AgentResourceFileInput<TFile>>;
  toolResource: string;
  userId: string;
}): AgentResourceDeletion<TFile> => {
  const attached = new Set(attachedFileIds);
  const inputsById = new Map(files.map((input) => [input.file_id, input]));
  const seen = new Set<string>();
  const ownedFiles: Array<AgentResourceFileInput<TFile>> = [];
  const unlinkOnlyFiles: AgentResourceFileRef[] = [];

  for (const fileId of requestedFileIds) {
    if (!attached.has(fileId) || seen.has(fileId)) {
      continue;
    }
    seen.add(fileId);
    const input = inputsById.get(fileId);
    if (input != null && input.owner === userId) {
      ownedFiles.push(input);
      continue;
    }
    unlinkOnlyFiles.push({ tool_resource: toolResource, file_id: fileId });
  }

  return { ownedFiles, unlinkOnlyFiles };
};

/**
 * Removes files from one agent tool resource, destroying only what this agent was the last holder
 * of.
 *
 * Three outcomes, decided per file. A file the caller does not own is unlinked and left whole. A
 * file the caller owns that any other `(agent, tool_resource)` pair still references is unlinked here
 * and left whole too:
 * duplicating an agent copies `file_ids` rather than the files behind them, so destroying the bytes
 * would empty the other agent's knowledge without touching its configuration. Only a file the
 * caller owns and this agent was the last to reference goes through the delete pass, which removes
 * the storage, the vector chunks and the metadata, and unlinks exactly what it managed to delete.
 */
export const deleteAgentResourceFiles = async <TFile>(
  {
    agentId,
    agentObjectId,
    toolResource,
    requestedFileIds,
    attachedFileIds,
    files,
    userId,
  }: {
    agentId: string;
    /** The agent's globally unique `_id`; `id` alone repeats across tenants. */
    agentObjectId: string;
    toolResource: string;
    requestedFileIds: string[];
    attachedFileIds: string[];
    files: Array<AgentResourceFileInput<TFile>>;
    userId: string;
  },
  deps: AgentResourceDeletionDeps<TFile>,
): Promise<AgentResourceDeletionResult> => {
  const { ownedFiles, unlinkOnlyFiles } = partitionAgentResourceFiles({
    requestedFileIds,
    attachedFileIds,
    files,
    toolResource,
    userId,
  });

  const sharedFileIds =
    ownedFiles.length === 0
      ? new Set<string>()
      : new Set(
          await deps.getSharedResourceFileIds({
            file_ids: ownedFiles.map((input) => input.file_id),
            excludeAgentObjectId: agentObjectId,
            excludeToolResource: toolResource,
          }),
        );

  const destroyable: Array<AgentResourceFileInput<TFile>> = [];
  const unlinkOnly = [...unlinkOnlyFiles];
  for (const input of ownedFiles) {
    if (sharedFileIds.has(input.file_id)) {
      unlinkOnly.push({ tool_resource: toolResource, file_id: input.file_id });
      continue;
    }
    destroyable.push(input);
  }

  /* The destroy runs before any reference is removed, and the delete pass strips the references of
     the files it actually deleted. A reference removed ahead of a destroy that then fails is what
     strands a file: it leaves the agent panel while its storage, chunks or metadata remain, and
     neither this route nor the client's retry queue can name it again. */
  const outcome =
    destroyable.length === 0
      ? null
      : await deps.deleteFiles(destroyable.map((input) => input.file));

  if (unlinkOnly.length > 0) {
    await deps.removeAgentResourceFiles({ agent_id: agentId, files: unlinkOnly });
  }

  return {
    outcome,
    unlinkedFileIds: unlinkOnly.map((ref) => ref.file_id),
    destroyedFileIds: outcome?.deletedFileIds ?? [],
  };
};

/** The canonical File deletion owner supplies this custody result only after its private guard.
 * Managed text publication's embedded flag never means a legacy vector namespace exists.
 */
export function requiresLegacyVectorDeletion(input: {
  embedded?: boolean;
  source: string;
  vectorSource: string;
  managedRetrievalSettled: boolean;
}): boolean {
  return (
    !input.managedRetrievalSettled && input.embedded === true && input.source !== input.vectorSource
  );
}

/** One admitted deletion keeps its real child effects until every promise settles. */
export interface FileDeletionWorkScope {
  effect<T>(start: () => Promise<T>): Promise<T>;
  queued<T>(enqueue: (dispatched: () => void) => Promise<T>): Promise<T>;
  markUncertain(): void;
}

export interface FileDeletionWorkOwner {
  maintenance: ApplicationWorkPort;
  run<T>(
    work: (scope: FileDeletionWorkScope) => Promise<T>,
    inheritedScope?: FileDeletionWorkScope,
  ): Promise<T>;
  stopAdmissions(): void;
  drain(): Promise<void>;
}

/** This owner never interprets cancellation or a rejected write as proof of no effect. */
export function createFileDeletionWorkOwner(): FileDeletionWorkOwner {
  const active = new Map<FileDeletionWorkScope, Promise<unknown>>();
  const children = new Map<FileDeletionWorkScope, Set<Promise<void>>>();
  let pausedBy: string | null = null;
  let stopped = false;
  let uncertain = false;
  let queued = 0;
  let draining: Promise<void> | undefined;
  const assertActive = (scope: FileDeletionWorkScope): void => {
    if (!active.has(scope)) throw new Error('FILE_DELETION_SCOPE_INACTIVE');
  };
  const observe = <T>(
    scope: FileDeletionWorkScope,
    start: () => Promise<T>,
    mutation: boolean,
  ): Promise<T> => {
    assertActive(scope);
    let original: Promise<T>;
    try {
      original = Promise.resolve(start());
    } catch (error) {
      original = Promise.reject(error);
    }
    const observed = original.catch((error: unknown) => {
      if (mutation) uncertain = true;
      throw error;
    });
    const settled = observed.then(
      () => undefined,
      () => undefined,
    );
    const pending = children.get(scope)!;
    pending.add(settled);
    void settled.then(() => pending.delete(settled));
    return observed;
  };
  const owner: FileDeletionWorkOwner = {
    maintenance: {
      pauseAdmissions(requestId) {
        if (!requestId || (pausedBy !== null && pausedBy !== requestId)) return false;
        pausedBy = requestId;
        return true;
      },
      resumeAdmissions(requestId) {
        if (stopped || uncertain || pausedBy !== requestId) return false;
        pausedBy = null;
        return true;
      },
      async getMaintenanceCensus(requestId) {
        return {
          admissionClosed: requestId !== null && pausedBy === requestId,
          queuedContinuations: queued,
          pendingWrites: active.size,
          complete: !uncertain && (pausedBy === null || pausedBy === requestId),
        };
      },
    },
    run<T>(
      work: (scope: FileDeletionWorkScope) => Promise<T>,
      inheritedScope?: FileDeletionWorkScope,
    ): Promise<T> {
      if (inheritedScope) return observe(inheritedScope, () => work(inheritedScope), false);
      if (stopped || pausedBy !== null) return Promise.reject(new Error('FILE_DELETION_QUIESCING'));
      let mutated = false;
      const scope: FileDeletionWorkScope = {
        effect<TValue>(start: () => Promise<TValue>): Promise<TValue> {
          assertActive(scope);
          mutated = true;
          return observe(scope, start, true);
        },
        queued<TValue>(enqueue: (dispatched: () => void) => Promise<TValue>): Promise<TValue> {
          assertActive(scope);
          queued++;
          let waiting = true;
          const dispatched = (): void => {
            if (!waiting) return;
            waiting = false;
            queued--;
          };
          return scope.effect(() => {
            try {
              return enqueue(dispatched).finally(dispatched);
            } catch (error) {
              dispatched();
              throw error;
            }
          });
        },
        markUncertain() {
          assertActive(scope);
          uncertain = true;
        },
      };
      let resolve!: (value: T | PromiseLike<T>) => void;
      let reject!: (error: unknown) => void;
      const original = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      const pending = new Set<Promise<void>>();
      active.set(scope, original);
      children.set(scope, pending);
      // Observe immediately: callers may await another admitted operation first.
      void original.catch(() => undefined);
      const execute = async (): Promise<T> => {
        try {
          return await work(scope);
        } catch (error) {
          if (mutated) uncertain = true;
          throw error;
        } finally {
          // Children can start another child while their original promise settles.
          while (pending.size) await Promise.all([...pending]);
        }
      };
      const release = (): void => {
        children.delete(scope);
        active.delete(scope);
      };
      void execute().then(
        (value) => {
          resolve(value);
          release();
        },
        (error: unknown) => {
          reject(error);
          release();
        },
      );
      return original;
    },
    stopAdmissions() {
      stopped = true;
    },
    drain() {
      stopped = true;
      draining ??= (async () => {
        await Promise.allSettled([...active.values()]);
        if (uncertain) throw new Error('FILE_DELETION_SETTLEMENT_UNCONFIRMED');
      })();
      return draining;
    },
  };
  return owner;
}

export const fileDeletionWorkOwner: FileDeletionWorkOwner = createFileDeletionWorkOwner();
