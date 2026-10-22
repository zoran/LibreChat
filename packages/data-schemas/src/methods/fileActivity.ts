/** One File owner for admission, finite claims and successful server-read settlement. */
import { randomBytes, randomUUID } from 'crypto';
import type {
  ManagedFileReadReference,
  ManagedFileReadRepresentation,
  UploadPrincipal,
  UploadWorker,
} from 'librechat-data-provider';
import type {
  FileReadRepository,
  ManagedFileReadClaim,
  ManagedFileReadEvidence,
  StoredFileReadReceipt,
} from '~/types/fileActivity';
import type { createUploadStore } from './uploadManagementStore';
import { createFileActivityStore, FileReadError, refuse, sha256 } from './fileActivityStore';
import { advanceFileRetentionActivity } from './fileActivityTransition';
import { projectFileHousekeeping } from './fileHousekeepingProjection';
import { mirrorFileActivityDeadline } from './uploadManagementStore';
import { refreshDerivedFileDeadlines } from './fileDerivedRetention';

const hash = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
function capturePrincipal(principal: UploadPrincipal) {
  return Object.freeze({ ...principal });
}
function reference(ticket: ManagedFileReadReference) {
  if (
    ticket?.version !== 1 ||
    typeof ticket.readId !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(ticket.readId) ||
    Buffer.from(ticket.readId, 'base64url').toString('base64url') !== ticket.readId ||
    !identifier(ticket.fileId) ||
    !['original', 'preview'].includes(ticket.representation)
  )
    refuse('not_found');
  return {
    key: sha256(ticket.readId),
    fileId: ticket.fileId,
    representation: ticket.representation,
  };
}
function workerIdentity(worker: UploadWorker) {
  if (!identifier(worker?.hostId) || !identifier(worker?.instanceId)) refuse('lease_lost');
  return Object.freeze({ hostId: worker.hostId, instanceId: worker.instanceId });
}
function capturedClaim(claim: ManagedFileReadClaim): ManagedFileReadClaim {
  if (
    claim?.version !== 1 ||
    !hash(claim.readKey) ||
    !identifier(claim.fileId) ||
    !identifier(claim.claimId) ||
    !Number.isSafeInteger(claim.fence) ||
    claim.fence <= 0 ||
    !hash(claim.sourceBindingSha256) ||
    !['original', 'preview'].includes(claim.representation)
  )
    refuse('lease_lost');
  return { ...claim, worker: workerIdentity(claim.worker) };
}
function sameClaim(row: StoredFileReadReceipt, claim: ManagedFileReadClaim): boolean {
  return (
    row.claim?.claimId === claim.claimId &&
    row.claim.fence === claim.fence &&
    row.claim.worker.hostId === claim.worker.hostId &&
    row.claim.worker.instanceId === claim.worker.instanceId
  );
}
function sameCompletion(row: StoredFileReadReceipt, claim: ManagedFileReadClaim): boolean {
  return row.completion?.claimId === claim.claimId && row.completion.fence === claim.fence;
}
function match(
  row: Pick<StoredFileReadReceipt, 'fileId' | 'representation'>,
  value: { fileId: string; representation: ManagedFileReadRepresentation },
) {
  if (row.fileId !== value.fileId || row.representation !== value.representation)
    refuse('not_found');
}
function refusal(error: unknown) {
  if (error instanceof FileReadError && !['busy', 'unavailable'].includes(error.code))
    return error.code as 'not_found' | 'expired' | 'revoked' | 'source_changed' | 'lease_lost';
  if ((error as { code?: string })?.code === 'principal_unavailable') return 'revoked' as const;
  return undefined;
}
const liveReceipt = (row: StoredFileReadReceipt, requireLease = false) => ({
  _id: row._id,
  fence: row.fence,
  $expr: {
    $and: [
      { $gt: ['$notAfter', '$$NOW'] },
      ...(requireLease ? [{ $gt: ['$claim.leaseUntil', '$$NOW'] }] : []),
    ],
  },
});

export function createFileActivityRepository(
  mongoose: typeof import('mongoose'),
  uploads: ReturnType<typeof createUploadStore>,
  options: { securityPolicySha256?: string } = {},
): FileReadRepository {
  const store = createFileActivityStore(mongoose, uploads, options);
  return {
    async admitManagedFileRead(principal, input) {
      const user = capturePrincipal(principal);
      const { fileId, representation } = input;
      if (!identifier(fileId) || !['original', 'preview'].includes(representation))
        refuse('not_found');
      const readId = randomBytes(32).toString('base64url');
      const readKey = sha256(readId);
      const admittedAt = Date.now();
      return store.transaction(admittedAt + 5000, async (session) => {
        const current = await store.source(user, fileId, representation, session);
        const notAfter = Math.min(admittedAt + 120000, current.file.expiredAt!.getTime());
        if (notAfter <= Date.now()) refuse('expired');
        await store.touchFile(user, current, session);
        await store.Receipt.create(
          [
            {
              _id: readKey,
              version: 1,
              tenantId: user.tenantId,
              userId: user.userId,
              fileId,
              representation,
              admittedAt: new Date(admittedAt),
              notAfter: new Date(notAfter),
              sourceBindingSha256: current.binding,
              originalSha256: current.originalSha256,
              originalBytes: current.originalBytes,
              fence: 0,
            },
          ],
          { session },
        );
        return Object.freeze({
          version: 1 as const,
          readId,
          fileId,
          representation,
          admittedAt: new Date(admittedAt).toISOString(),
          notAfter: new Date(notAfter).toISOString(),
        });
      });
    },
    async claimManagedFileRead(principal, ticket, worker, previousClaim) {
      const user = capturePrincipal(principal),
        ref = reference(ticket),
        identity = workerIdentity(worker);
      const previous = previousClaim && capturedClaim(previousClaim);
      if (previous) match(ref, previous);
      const preliminary = await store.receipt(user, ref.key);
      if (
        previous &&
        preliminary.notAfter.getTime() > Date.now() &&
        (!sameClaim(preliminary, previous) || preliminary.claim!.leaseUntil.getTime() <= Date.now())
      )
        refuse('lease_lost');
      const budget = Math.min(
        preliminary.notAfter.getTime(),
        previous ? (preliminary.claim?.leaseUntil.getTime() ?? 0) : Infinity,
      );
      const claimId = previous?.claimId ?? randomUUID();
      return store.transaction(budget, async (session) => {
        const row = await store.receiptInTransaction(user, ref.key, session);
        match(row, ref);
        const current = await store.source(user, row.fileId, row.representation, session);
        if (row.sourceBindingSha256 !== current.binding) refuse('source_changed');
        const now = Date.now();
        if (previous) {
          if (
            previous.readKey !== ref.key ||
            !sameClaim(row, previous) ||
            row.claim!.leaseUntil.getTime() <= now ||
            previous.worker.hostId !== identity.hostId ||
            previous.worker.instanceId !== identity.instanceId
          )
            refuse('lease_lost');
        } else if (row.claim && row.claim.leaseUntil.getTime() > now) refuse('busy');
        if (row.fence >= Number.MAX_SAFE_INTEGER) refuse('unavailable');
        const claim = {
          claimId,
          fence: previous ? row.fence : row.fence + 1,
          worker: identity,
          leaseUntil: new Date(Math.min(now + 5000, row.notAfter.getTime())),
        };
        // This same File write is mandatory even for renewal: a winning freeze/revoke must conflict.
        await store.touchFile(user, current, session);
        const written = await store.Receipt.updateOne(
          liveReceipt(row, !!previous),
          { $set: { claim, fence: claim.fence } },
          { session },
        );
        if (written.matchedCount !== 1) refuse('lease_lost');
        return Object.freeze({
          version: 1 as const,
          readKey: row._id,
          claimId,
          fence: claim.fence,
          worker: identity,
          fileId: row.fileId,
          representation: row.representation,
          sourceBindingSha256: row.sourceBindingSha256,
          notAfter: row.notAfter.toISOString(),
          leaseUntil: claim.leaseUntil.toISOString(),
        });
      });
    },
    async completeManagedFileRead(principal, rawClaim, rawEvidence) {
      try {
        const user = capturePrincipal(principal),
          claim = capturedClaim(rawClaim);
        const descriptors = rawEvidence && Object.getOwnPropertyDescriptors(rawEvidence);
        const keys = [
          'version',
          'representation',
          'sourceBindingSha256',
          'contentSha256',
          'verifiedBytes',
        ];
        if (
          !descriptors ||
          Reflect.ownKeys(rawEvidence).length !== keys.length ||
          keys.some((key) => !descriptors[key] || !('value' in descriptors[key]))
        )
          refuse('source_changed');
        const evidence: ManagedFileReadEvidence = { ...rawEvidence };
        if (
          evidence.version !== 1 ||
          evidence.representation !== claim.representation ||
          evidence.sourceBindingSha256 !== claim.sourceBindingSha256 ||
          !hash(evidence.contentSha256) ||
          !Number.isSafeInteger(evidence.verifiedBytes) ||
          evidence.verifiedBytes < 1
        )
          refuse('source_changed');
        const preliminary = await store.receipt(user, claim.readKey);
        if (
          preliminary.notAfter.getTime() > Date.now() &&
          !sameCompletion(preliminary, claim) &&
          (!sameClaim(preliminary, claim) || preliminary.claim!.leaseUntil.getTime() <= Date.now())
        )
          refuse('lease_lost');
        const budget = Math.min(
          preliminary.notAfter.getTime(),
          sameCompletion(preliminary, claim)
            ? Infinity
            : (preliminary.claim?.leaseUntil.getTime() ?? 0),
        );
        const completedAt = Date.now();
        return await store.transaction(budget, async (session) => {
          const row = await store.receiptInTransaction(user, claim.readKey, session);
          match(row, claim);
          const current = await store.source(user, row.fileId, row.representation, session);
          if (
            current.binding !== row.sourceBindingSha256 ||
            current.binding !== evidence.sourceBindingSha256 ||
            current.contentSha256 !== evidence.contentSha256 ||
            current.verifiedBytes !== evidence.verifiedBytes
          )
            refuse('source_changed');
          const ownsClaim = sameClaim(row, claim) && row.claim!.leaseUntil.getTime() > Date.now();
          if (row.completion) {
            if (!ownsClaim && !sameCompletion(row, claim)) refuse('lease_lost');
            if (
              row.completion.contentSha256 !== evidence.contentSha256 ||
              row.completion.verifiedBytes !== evidence.verifiedBytes
            )
              refuse('source_changed');
            await store.touchFile(user, current, session);
            if (ownsClaim) {
              const released = await store.Receipt.updateOne(
                { ...liveReceipt(row, true), 'claim.claimId': claim.claimId },
                { $unset: { claim: '' } },
                { session },
              );
              if (released.matchedCount !== 1) refuse('lease_lost');
            }
            return {
              status: 'completed' as const,
              firstCompletion: false,
              completedAt: row.completion.completedAt.toISOString(),
            };
          }
          if (!ownsClaim) refuse('lease_lost');
          const next = advanceFileRetentionActivity(
            current.file.retentionActivity,
            current.file.expiredAt,
            'read',
            completedAt,
            Date.now(),
          );
          const changed = await store.File.updateOne(
            {
              ...store.fileFilter(user, row.fileId, Date.now()),
              retentionRevision: current.file.retentionRevision,
              expiredAt: current.file.expiredAt,
            },
            {
              $set: { expiredAt: next.expiredAt, retentionActivity: next.activity },
              $inc: { retentionRevision: 1 },
            },
            { session, timestamps: false },
          );
          if (changed.matchedCount !== 1) refuse('revoked');
          const nextFile = {
            ...current.file,
            expiredAt: next.expiredAt,
            retentionActivity: next.activity,
            retentionRevision: (current.file.retentionRevision ?? 0) + 1,
          };
          await refreshDerivedFileDeadlines(mongoose, user, current.file, nextFile, session);
          await projectFileHousekeeping(mongoose, current.file, nextFile, session);
          await mirrorFileActivityDeadline(
            mongoose,
            current.operation,
            next.expiredAt.getTime(),
            session,
          );
          const written = await store.Receipt.updateOne(
            {
              ...liveReceipt(row, true),
              'claim.claimId': claim.claimId,
              'claim.fence': claim.fence,
              completion: { $exists: false },
            },
            {
              $set: {
                completion: {
                  claimId: claim.claimId,
                  fence: claim.fence,
                  completedAt: new Date(completedAt),
                  contentSha256: evidence.contentSha256,
                  verifiedBytes: evidence.verifiedBytes,
                  deadlineGeneration: next.activity.deadlineGeneration,
                  deadlineAt: next.expiredAt,
                },
              },
              $unset: { claim: '' },
            },
            { session },
          );
          if (written.matchedCount !== 1) refuse('lease_lost');
          return {
            status: 'completed' as const,
            firstCompletion: true,
            completedAt: new Date(completedAt).toISOString(),
          };
        });
      } catch (error) {
        const reason = refusal(error);
        return reason ? { status: 'refused', reason } : { status: 'unknown' };
      }
    },
    async inspectManagedFileRead(principal, ticket) {
      try {
        const user = capturePrincipal(principal),
          ref = reference(ticket);
        const preliminary = await store.receipt(user, ref.key);
        return await store.transaction(preliminary.notAfter.getTime(), async (session) => {
          const row = await store.receiptInTransaction(user, ref.key, session);
          match(row, ref);
          const current = await store.source(user, row.fileId, row.representation, session);
          if (row.sourceBindingSha256 !== current.binding) refuse('source_changed');
          await store.touchFile(user, current, session);
          const notAfter = row.notAfter.toISOString();
          if (row.completion)
            return {
              status: 'completed' as const,
              notAfter,
              completedAt: row.completion.completedAt.toISOString(),
            };
          if (row.claim && row.claim.leaseUntil.getTime() > Date.now())
            return { status: 'reading' as const, notAfter, retryAfterMs: 1000 as const };
          return { status: 'admitted' as const, notAfter };
        });
      } catch (error) {
        const reason = refusal(error);
        return reason && reason !== 'lease_lost'
          ? { status: 'refused', reason }
          : { status: 'unknown', retryAfterMs: 1000 };
      }
    },
    async abandonManagedFileRead(principal, rawClaim, input) {
      try {
        const user = capturePrincipal(principal),
          claim = capturedClaim(rawClaim);
        if (!['aborted', 'read_failed'].includes(input.reason)) refuse('lease_lost');
        const preliminary = await store.receipt(user, claim.readKey);
        return await store.transaction(preliminary.notAfter.getTime(), async (session) => {
          const row = await store.receiptInTransaction(user, claim.readKey, session);
          match(row, claim);
          if (!sameClaim(row, claim) && !sameCompletion(row, claim)) refuse('lease_lost');
          if (sameClaim(row, claim)) {
            const result = await store.Receipt.updateOne(
              { ...liveReceipt(row), 'claim.claimId': claim.claimId },
              { $unset: { claim: '' } },
              { session },
            );
            if (result.matchedCount !== 1) refuse('lease_lost');
          }
          return row.completion
            ? {
                status: 'completed' as const,
                completedAt: row.completion.completedAt.toISOString(),
              }
            : { status: 'released' as const };
        });
      } catch (error) {
        const reason = refusal(error);
        return reason && ['expired', 'lease_lost', 'not_found'].includes(reason)
          ? { status: 'refused', reason: reason as 'expired' | 'lease_lost' | 'not_found' }
          : { status: 'unknown' };
      }
    },
  };
}
