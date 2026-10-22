/** Personal managed retrieval composition. File remains the authority before and after transport. */
import { createHash, randomUUID } from 'node:crypto';
import { parseFileRetrievalPolicySnapshot } from '@librechat/data-schemas';
import {
  canonicalManagedJson,
  managedDigest,
  managedIndexProfileSchema,
  managedOwnerSchema,
  readManagedRetrievalRequest,
  validateManagedCapability,
  validateManagedRetrievalLookup,
  verifyManagedIndexReceipt,
  verifyManagedQueryResult,
} from 'librechat-data-provider';
import type {
  ManagedCapability,
  ManagedIndexReceipt,
  ManagedPurgeReceipt,
  ManagedQueryResult,
  ManagedRetrievalLookup,
  ManagedRetrievalLookupRequest,
  ManagedRetrievalTrustedSource,
} from 'librechat-data-provider';
import type {
  FileRetrievalOriginal,
  FileRetrievalPolicySnapshot,
  FileRetrievalRequest,
} from '@librechat/data-schemas';
import type { z } from 'zod';
import type { ManagedSourceAccess, ManagedSourceResolver } from '../managedSource';
import type { RetrievalLookupHandler } from '~/uploads/intake/retrieval-lookup';
import type { ApplicationWorkPort } from '~/app/maintenance';
import { createManagedRagClient } from './transport';

type Owner = FileRetrievalRequest['owner'];
type SourceRequest = Parameters<ManagedSourceResolver['resolve']>[0];
type Client = ReturnType<typeof createManagedRagClient>;
type Authority = Awaited<ReturnType<Parameters<Client['invoke']>[0]['authorize']>>;
type IndexProfile = z.infer<typeof managedIndexProfileSchema>;

/** Only the trusted deployment owner may supply this configuration after its native gate.
 * No environment flag, employee request, health response or fixture constructs this binding.
 * Extraction remains independently usable when no retrieval binding exists.
 */
export type TrustedManagedFileConfiguration = {
  extractionPolicySha256?: string;
  retrieval?: {
    profile: IndexProfile;
    policySnapshot: FileRetrievalPolicySnapshot;
    transport: { backendIdentity: string; url: string; serverCertificateSha256: string };
  };
};

/** Database types stay behind the existing File owner; callers cannot supply policy per operation. */
export type ManagedFileRetrievalOperations = {
  initialize(): Promise<void>;
  admit(request: FileRetrievalRequest): Promise<FileRetrievalOriginal>;
  lookup(
    request: ManagedRetrievalLookupRequest,
    peer: { backendIdentity: string },
    signal?: AbortSignal,
    deadlineAt?: number,
  ): Promise<ManagedRetrievalLookup>;
  admitPurge(request: { owner: Owner; fileId: string }): Promise<FileRetrievalOriginal[]>;
  acknowledgeIndex(
    request: { owner: Owner; operationId: string; receipt: ManagedIndexReceipt },
    peer: { backendIdentity: string },
  ): Promise<void>;
  acknowledgePurge(
    request: { owner: Owner; operationId: string; receipt: ManagedPurgeReceipt },
    peer: { backendIdentity: string },
  ): Promise<void>;
};
export type ManagedFilePurgeOperations = Pick<
  ManagedFileRetrievalOperations,
  'initialize' | 'lookup' | 'admitPurge' | 'acknowledgePurge'
>;
export type ManagedFilePurge = {
  /** Called by the canonical File deletion owner after source and generation revocation. */
  purge(owner: Owner, fileIds: readonly string[], signal?: AbortSignal): Promise<void>;
  close(signal?: AbortSignal): Promise<void>;
};
export interface ManagedFilePurgeOptions {
  trustedFile: TrustedManagedFileConfiguration;
  operations(policy: FileRetrievalPolicySnapshot): ManagedFilePurgeOperations;
  runAsSystem<T>(work: () => Promise<T>): Promise<T>;
  /** Acquisition guard only; the process shutdown owner retains the initialization original. */
  signal: AbortSignal;
}
export type ManagedFileRetrieval = ManagedFilePurge & {
  lookup: RetrievalLookupHandler;
  maintenance: ApplicationWorkPort;
  index(
    request: SourceRequest,
    input: { fileId: string; operationId: string; signal?: AbortSignal },
  ): Promise<void>;
  query(
    request: SourceRequest,
    input: {
      fileIds: string[];
      operationId: string;
      query: string;
      limit: number;
      signal?: AbortSignal;
    },
  ): Promise<ManagedQueryResult>;
};
const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const same = (left: unknown, right: unknown) =>
  canonicalManagedJson(left) === canonicalManagedJson(right);
function unavailable(): never {
  throw Object.assign(new Error('Managed retrieval unavailable'), {
    code: 'managed_retrieval_unavailable',
  });
}

/** Internal route selection over the already admitted ordered keys. */
export function managedFileRetrievalPath(
  purpose: FileRetrievalOriginal['purpose'],
  keyCount: number,
): Parameters<Client['invoke']>[0]['path'] {
  if (purpose === 'index') return '/embed';
  if (purpose === 'purge') return '/documents';
  return keyCount === 1 ? '/query' : '/query_multiple';
}

/** Recheck the issued grant after the final asynchronous File read, without renewing it. */
export async function assertManagedFileRetrievalRelease(
  capability: ManagedCapability,
  authorize: () => Promise<Authority>,
  signal: AbortSignal,
): Promise<void> {
  const current = await authorize();
  signal.throwIfAborted();
  validateManagedCapability(capability, { ...current, now: Math.floor(Date.now() / 1000) });
}

async function createManagedFileLifecycle<Operations extends ManagedFilePurgeOperations>(options: {
  trustedFile: TrustedManagedFileConfiguration;
  operations(policy: FileRetrievalPolicySnapshot): Operations;
  runAsSystem<T>(work: () => Promise<T>): Promise<T>;
  signal?: AbortSignal;
}) {
  options.signal?.throwIfAborted();
  if (!options.trustedFile?.retrieval) unavailable();
  // Detach the immutable deployed inputs before the first asynchronous boundary.
  const config: TrustedManagedFileConfiguration = JSON.parse(
    canonicalManagedJson(options.trustedFile),
  );
  const binding = config.retrieval!;
  const profile = managedIndexProfileSchema.parse(binding.profile);
  const generation = managedDigest(profile, sha);
  const policy = parseFileRetrievalPolicySnapshot(binding.policySnapshot);
  const backend = binding.transport.backendIdentity;
  if (
    !/^[a-f0-9]{64}$/.test(config.extractionPolicySha256 ?? '') ||
    policy.content.indexGeneration !== generation ||
    policy.content.backendIdentity !== backend ||
    !policy.purge.some((retained) => same(retained, policy.content))
  )
    unavailable();
  const operations = options.operations(policy);
  await options.runAsSystem(() => operations.initialize());
  options.signal?.throwIfAborted();
  const client = createManagedRagClient(binding.transport);
  const peer = Object.freeze({ backendIdentity: backend });
  const lifetime = new AbortController();
  const pending = new Set<Promise<unknown>>();
  // This process census never substitutes for the retained File/backend operation originals.
  // A transport or commit ambiguity remains a drain blocker until its exact retry settles.
  const unresolved = new Set<string>();
  let pausedBy: string | null = null;

  function run<T>(
    work: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
    lookup = false,
  ): Promise<T> {
    lifetime.signal.throwIfAborted();
    if (pausedBy !== null && !lookup) unavailable();
    const combined = signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal;
    combined.throwIfAborted();
    const result = Promise.resolve().then(() => work(combined));
    pending.add(result);
    void result.finally(() => pending.delete(result)).catch(() => undefined);
    return result;
  }

  async function dispatch(
    original: FileRetrievalOriginal,
    body: unknown,
    signal: AbortSignal,
    revalidate: () => Promise<void>,
  ): Promise<{ response: unknown; assertCurrent: () => Promise<void> }> {
    const keys = original.sources.flatMap((source) => source.keys);
    if (
      original.policy.backendIdentity !== backend ||
      original.bodySha256 !== sha(canonicalManagedJson(body))
    )
      unavailable();
    const selector: ManagedRetrievalLookupRequest = {
      version: 1,
      owner: original.owner,
      operationId: original.operationId,
      requestedPurpose: original.purpose,
    };
    async function authorize(): Promise<Authority> {
      signal.throwIfAborted();
      await revalidate();
      const value = await options.runAsSystem(() =>
        operations.lookup(
          selector,
          peer,
          signal,
          Math.min(Date.now() + 5_000, original.workDeadline),
        ),
      );
      const lookup = validateManagedRetrievalLookup(value, selector, backend, sha);
      if (
        lookup.status !== 'available' ||
        lookup.original.originalSha256 !== original.originalSha256 ||
        !same(
          lookup.sources.map((source) => source.key),
          keys,
        )
      )
        unavailable();
      const authority = lookup.authority;
      return {
        purpose: authority.purpose,
        owner: original.owner,
        backendIdentity: backend,
        requestSha256: authority.requestSha256,
        operationId: original.operationId,
        keys,
        writerEpoch: authority.writerEpoch,
        workDeadline: authority.workDeadline,
        routePolicySha256: authority.routePolicySha256,
        ...(authority.sourceExpiresAt === null
          ? {}
          : { sourceExpiresAt: authority.sourceExpiresAt }),
        ...(authority.cleanupDeadline === null
          ? {}
          : { cleanupDeadline: authority.cleanupDeadline }),
      };
    }
    const authority = await authorize();
    const now = Math.floor(Date.now() / 1000);
    const deadline =
      original.purpose === 'purge' ? authority.cleanupDeadline : authority.sourceExpiresAt;
    if (deadline === undefined) unavailable();
    const capability: ManagedCapability = {
      version: 1,
      iss: 'cortex-librechat',
      aud: 'cortex-rag',
      sub: original.owner.userId,
      owner: original.owner,
      purpose: original.purpose,
      jti: randomUUID(),
      iat: now,
      nbf: now,
      exp: Math.min(now + 60, authority.workDeadline, deadline),
      backendIdentity: backend,
      requestSha256: original.bodySha256,
      keys,
      allowedEntityIds: [],
      operationId: original.operationId,
      writerEpoch: original.policy.writerEpoch,
      workDeadline: authority.workDeadline,
      routePolicySha256: original.policy.routePolicySha256,
    };
    const response = await client.invoke({
      purpose: original.purpose,
      method: original.purpose === 'purge' ? 'DELETE' : 'POST',
      path: managedFileRetrievalPath(original.purpose, keys.length),
      body,
      capability,
      authorize,
      signal,
    });
    return {
      response,
      assertCurrent: () => assertManagedFileRetrievalRelease(capability, authorize, signal),
    };
  }

  return {
    config,
    generation,
    backend,
    operations,
    peer,
    run,
    dispatch,
    unresolved,
    maintenance: {
      pauseAdmissions(requestId) {
        if (!requestId || (pausedBy !== null && pausedBy !== requestId)) return false;
        pausedBy = requestId;
        return true;
      },
      resumeAdmissions(requestId) {
        if (lifetime.signal.aborted || pausedBy !== requestId || unresolved.size) return false;
        pausedBy = null;
        return true;
      },
      async getMaintenanceCensus(requestId) {
        return {
          admissionClosed: requestId !== null && pausedBy === requestId,
          queuedContinuations: 0,
          pendingWrites: pending.size,
          complete: !unresolved.size && (pausedBy === null || pausedBy === requestId),
        };
      },
    } satisfies ApplicationWorkPort,
    lookup: ((request, authenticatedPeer, signal, deadlineAt) => {
      return run(
        (active) =>
          options.runAsSystem(() =>
            operations.lookup(request, authenticatedPeer, active, deadlineAt),
          ),
        signal,
        true,
      );
    }) satisfies RetrievalLookupHandler,
    purge(inputOwner: Owner, fileIds: readonly string[], signal?: AbortSignal) {
      const owner = managedOwnerSchema.parse(inputOwner);
      const ids = [...new Set(fileIds)];
      return run(async (active) => {
        for (const fileId of ids) {
          active.throwIfAborted();
          const work = canonicalManagedJson({ owner, purgeFileId: fileId });
          unresolved.add(work);
          const originals = await options.runAsSystem(() =>
            operations.admitPurge({ owner, fileId }),
          );
          for (const original of originals) {
            const body = readManagedRetrievalRequest('purge', {
              version: 1,
              purgeOperationId: original.operationId,
              keys: original.sources.flatMap((source) => source.keys),
              writerEpoch: original.policy.writerEpoch,
            });
            const { response } = await dispatch(original, body, active, async () =>
              active.throwIfAborted(),
            );
            // File revalidates every original, key and receipt in its acknowledgement transaction.
            await options.runAsSystem(() =>
              operations.acknowledgePurge(
                {
                  owner,
                  operationId: original.operationId,
                  receipt: response as ManagedPurgeReceipt,
                },
                peer,
              ),
            );
          }
          unresolved.delete(work);
        }
      }, signal);
    },
    async close(signal?: AbortSignal) {
      lifetime.abort();
      client.close();
      let aborted: (() => void) | undefined;
      try {
        await Promise.race([
          Promise.allSettled([...pending]),
          new Promise<never>((_resolve, reject) => {
            if (!signal) return;
            aborted = () => reject(new Error('Managed retrieval shutdown has unresolved work'));
            if (signal.aborted) aborted();
            else signal.addEventListener('abort', aborted, { once: true });
          }),
        ]);
        if (unresolved.size) throw new Error('Managed retrieval shutdown has unresolved work');
      } finally {
        if (aborted) signal?.removeEventListener('abort', aborted);
      }
    },
  };
}

/** An absent binding creates no operation store, transport, credential read or background work. */
export async function createManagedFileRetrieval(options: {
  trustedFile?: TrustedManagedFileConfiguration;
  sources: ManagedSourceResolver;
  operations(policy: FileRetrievalPolicySnapshot): ManagedFileRetrievalOperations;
  runAsSystem<T>(work: () => Promise<T>): Promise<T>;
  signal?: AbortSignal;
}): Promise<ManagedFileRetrieval | undefined> {
  if (!options.trustedFile?.retrieval) return undefined;
  const lifecycle = await createManagedFileLifecycle({
    trustedFile: options.trustedFile,
    operations: (policy) => options.operations(policy),
    runAsSystem: (work) => options.runAsSystem(work),
    signal: options.signal,
  });
  const { config, generation, backend, operations, peer, run, dispatch, unresolved } = lifecycle;

  async function sourceInputs(
    request: SourceRequest,
    fileIds: readonly string[],
    signal: AbortSignal,
  ): Promise<{
    owner: Owner;
    accesses: ManagedSourceAccess[];
    trusted: ManagedRetrievalTrustedSource[];
  }> {
    if (!fileIds.length || fileIds.length > 32 || new Set(fileIds).size !== fileIds.length)
      unavailable();
    const principal = await options.sources.authorize(request);
    if (principal.authentication !== 'verified-email') unavailable();
    const owner = managedOwnerSchema.parse({
      tenantId: principal.tenantId,
      userId: principal.userId,
    });
    const accesses: ManagedSourceAccess[] = [];
    for (const id of fileIds) {
      signal.throwIfAborted();
      const source = await options.sources.resolve(request, id, { text: true, signal });
      if (
        !source.revision ||
        !source.document ||
        !same(source.revision.owner, owner) ||
        source.revision.source.fileId !== id ||
        source.revision.extractionPolicySha256 !== config.extractionPolicySha256
      )
        unavailable();
      accesses.push(source);
    }
    return {
      owner,
      accesses,
      trusted: accesses.map((source) => ({
        key: {
          sourceRevision: source.revision!.sourceRevision,
          representationRevision: source.revision!.representationRevision,
          indexGeneration: generation,
        },
        revision: source.revision!,
        document: source.document!,
      })),
    };
  }

  return {
    maintenance: lifecycle.maintenance,
    lookup: lifecycle.lookup,
    purge: lifecycle.purge,
    close: lifecycle.close,
    index(request, input) {
      const { fileId, operationId, signal: parentSignal } = input;
      return run(async (signal) => {
        const { owner, accesses, trusted } = await sourceInputs(request, [fileId], signal);
        const body = readManagedRetrievalRequest('index', {
          version: 1,
          operationId,
          key: trusted[0].key,
          document: trusted[0].document,
        });
        const work = canonicalManagedJson({ owner, operationId: body.operationId });
        unresolved.add(work);
        const original = await options.runAsSystem(() =>
          operations.admit({
            owner,
            operationId,
            purpose: 'index',
            fileIds: [fileId],
            body,
          }),
        );
        if (
          !same(
            original.sources.flatMap((source) => source.keys),
            [body.key],
          )
        )
          unavailable();
        const revalidate = async () => {
          await options.sources.revalidate(request, accesses[0]);
          signal.throwIfAborted();
        };
        const { response } = await dispatch(original, body, signal, revalidate);
        const receipt = verifyManagedIndexReceipt(
          response,
          {
            operationId: original.operationId,
            requestSha256: original.bodySha256,
            backendIdentity: backend,
            writerEpoch: original.policy.writerEpoch,
            key: body.key,
            admittedAt: Math.floor(original.admittedAt / 1000),
            workDeadline: Math.floor(original.workDeadline / 1000),
          },
          sha,
        );
        await revalidate();
        await options.runAsSystem(() =>
          operations.acknowledgeIndex(
            {
              owner,
              operationId: original.operationId,
              receipt,
            },
            peer,
          ),
        );
        unresolved.delete(work);
      }, parentSignal);
    },
    query(request, input) {
      const { operationId, query, limit, signal: parentSignal } = input;
      const fileIds = [...input.fileIds];
      return run(async (signal) => {
        const { owner, accesses, trusted } = await sourceInputs(request, fileIds, signal);
        const body = readManagedRetrievalRequest('query', {
          version: 1,
          operationId,
          keys: trusted.map((source) => source.key),
          query,
          limit,
        });
        const work = canonicalManagedJson({ owner, operationId: body.operationId });
        unresolved.add(work);
        const original = await options.runAsSystem(() =>
          operations.admit({
            owner,
            operationId,
            purpose: 'query',
            fileIds: accesses.map((source) => source.file.file_id),
            body,
          }),
        );
        if (
          !same(
            original.sources.flatMap((source) => source.keys),
            body.keys,
          )
        )
          unavailable();
        const revalidate = async () => {
          for (const source of accesses) {
            await options.sources.revalidate(request, source);
            signal.throwIfAborted();
          }
        };
        const { response, assertCurrent } = await dispatch(original, body, signal, revalidate);
        if (!original.policy.rankingPolicySha256) unavailable();
        const result = verifyManagedQueryResult(
          response,
          {
            operationId: original.operationId,
            requestSha256: original.bodySha256,
            backendIdentity: backend,
            writerEpoch: original.policy.writerEpoch,
            keys: body.keys,
            rankingPolicySha256: original.policy.rankingPolicySha256,
            limit: body.limit,
          },
          trusted,
          sha,
        );
        await assertCurrent();
        unresolved.delete(work);
        return result;
      }, parentSignal);
    },
  };
}

/** Cleanup composition requires the existing trusted File and transport authorities. */
export async function createManagedFilePurge(
  options: ManagedFilePurgeOptions,
): Promise<ManagedFilePurge> {
  if (!(options.signal instanceof AbortSignal)) unavailable();
  const lifecycle = await createManagedFileLifecycle(options);
  return { purge: lifecycle.purge, close: lifecycle.close };
}

/** Join the two existing owners behind Uploads' existing application maintenance port. */
export function composeManagedFileMaintenance(
  uploads: ApplicationWorkPort,
  retrieval?: ManagedFileRetrieval,
): ApplicationWorkPort {
  if (!retrieval) return uploads;
  return {
    pauseAdmissions(requestId) {
      const uploadClosed = uploads.pauseAdmissions(requestId);
      const retrievalClosed = retrieval.maintenance.pauseAdmissions(requestId);
      return uploadClosed && retrievalClosed;
    },
    resumeAdmissions(requestId) {
      if (!retrieval.maintenance.resumeAdmissions(requestId)) return false;
      if (uploads.resumeAdmissions(requestId)) return true;
      retrieval.maintenance.pauseAdmissions(requestId);
      return false;
    },
    async getMaintenanceCensus(requestId) {
      const results = await Promise.all([
        uploads.getMaintenanceCensus(requestId),
        retrieval.maintenance.getMaintenanceCensus(requestId),
      ]);
      return {
        admissionClosed: results.every((value) => value.admissionClosed),
        queuedContinuations: results.reduce((sum, value) => sum + value.queuedContinuations, 0),
        pendingWrites: results.reduce((sum, value) => sum + value.pendingWrites, 0),
        complete: results.every((value) => value.complete),
      };
    },
  };
}
