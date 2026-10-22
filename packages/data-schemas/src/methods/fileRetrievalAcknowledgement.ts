/** File-owned acknowledgement of authenticated backend outcomes; originals are never rewritten. */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import {
  canonicalManagedJson,
  managedOwnerSchema,
  managedPurgeReceiptSchema,
  managedRetrievalStateSchema,
  verifyManagedIndexReceipt,
  verifyManagedPurgeReceipt,
} from 'librechat-data-provider';
import type {
  ManagedIndexReceipt,
  ManagedPurgeReceipt,
  ManagedRetrievalState,
} from 'librechat-data-provider';
import type { Model, ClientSession } from 'mongoose';
import type { FileRetrievalOriginal } from './fileRetrievalOperationContract';
import type { IMongoFile } from '~/types';
import { fileSourceScope, liveFileFilter } from './fileRetention';

const id = z.string().min(1).max(256);
type Request = {
  owner: z.infer<typeof managedOwnerSchema>;
  operationId: string;
  receipt: ManagedPurgeReceipt;
};
const requestSchema: z.ZodType<Request> = z
  .object({
    owner: managedOwnerSchema,
    operationId: id,
    receipt: managedPurgeReceiptSchema,
  })
  .strict();
const peerSchema = z.object({ backendIdentity: id }).strict();
type IndexRequest = Pick<Request, 'owner' | 'operationId'> & { receipt: ManagedIndexReceipt };
const indexRequestSchema = z
  .object({
    owner: managedOwnerSchema,
    operationId: id,
    receipt: z.unknown(),
  })
  .strict();
type Obligation = ManagedRetrievalState['obligations'][number];
const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const equal = (left: unknown, right: unknown) =>
  canonicalManagedJson(left) === canonicalManagedJson(right);
const unavailable = (): never => {
  throw Object.assign(new Error('Managed retrieval acknowledgement unavailable'), {
    code: 'managed_retrieval_acknowledgement_unavailable',
  });
};

/** The caller supplies the authenticated transport peer separately from the response.
 * Retained history and current cleanup policy remain owned by FileRetrievalOperation.
 */
export function createFileRetrievalAcknowledgements(
  mongoose: typeof import('mongoose'),
  authority: {
    original(
      request: Pick<Request, 'owner' | 'operationId'>,
      session: ClientSession,
    ): Promise<FileRetrievalOriginal>;
    history(
      owner: Request['owner'],
      fileId: string,
      entry: Obligation,
      session: ClientSession,
    ): Promise<unknown>;
    recordIndexReceipt(
      original: FileRetrievalOriginal,
      receipt: ManagedIndexReceipt,
      session: ClientSession,
    ): Promise<void>;
  },
): {
  acknowledgeIndex(value: IndexRequest, peer: { backendIdentity: string }): Promise<void>;
  acknowledgePurge(value: Request, peer: { backendIdentity: string }): Promise<void>;
} {
  const File = mongoose.models.File as Model<IMongoFile>;
  return {
    async acknowledgeIndex(value, authenticatedPeer) {
      canonicalManagedJson(value);
      const request = indexRequestSchema.parse(JSON.parse(canonicalManagedJson(value)));
      const peer = peerSchema.parse(authenticatedPeer);
      const scope = fileSourceScope(request.owner);
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(
          async () => {
            const original = await authority.original(request, session);
            if (
              original.purpose !== 'index' ||
              original.sources.length !== 1 ||
              original.sources[0].keys.length !== 1 ||
              original.sources[0].revisions.length !== 1 ||
              original.policy.backendIdentity !== peer.backendIdentity ||
              !equal(original.owner, request.owner) ||
              original.operationId !== request.operationId ||
              Date.now() >= original.workDeadline
            )
              unavailable();
            const source = original.sources[0];
            const key = source.keys[0];
            const receipt = verifyManagedIndexReceipt(
              request.receipt,
              {
                operationId: original.operationId,
                requestSha256: original.bodySha256,
                backendIdentity: original.policy.backendIdentity,
                writerEpoch: original.policy.writerEpoch,
                key,
                admittedAt: Math.floor(original.admittedAt / 1000),
                workDeadline: Math.floor(original.workDeadline / 1000),
              },
              sha,
            );
            const filter = {
              $and: [
                scope,
                {
                  tenantId: { $exists: true },
                  file_id: source.fileId,
                  retentionAcceptedAt: { $ne: null },
                },
                liveFileFilter(),
              ],
            };
            const rows = await File.find(filter)
              .select('+managedRetrieval')
              .session(session)
              .lean<IMongoFile[]>();
            if (rows.length !== 1) unavailable();
            const row = rows[0];
            const state = managedRetrievalStateSchema.parse(row.managedRetrieval);
            const expiresAt = new Date(row.expiredAt ?? '').getTime();
            if (
              !equal(state.revision, source.revisions[0]) ||
              !equal(state.revision?.owner, request.owner) ||
              state.revision?.source.fileId !== source.fileId ||
              row.deletionRequestedAt ||
              row.deletionCompletedAt ||
              !Number.isSafeInteger(expiresAt) ||
              expiresAt <= Date.now()
            )
              unavailable();
            const matches = state.obligations.filter(
              (entry) => entry.backendIdentity === peer.backendIdentity && equal(entry.key, key),
            );
            if (matches.length !== 1) unavailable();
            const entry = matches[0];
            if (
              !['preparing', 'ready', 'unknown'].includes(entry.state) ||
              entry.operationId !== original.operationId ||
              entry.requestSha256 !== original.bodySha256 ||
              entry.writerEpoch !== original.policy.writerEpoch ||
              entry.purgeOperationId !== undefined ||
              entry.receiptSha256 !== undefined
            )
              unavailable();
            await authority.history(request.owner, source.fileId, entry, session);
            // The exact ready receipt and File transition commit together; retries cannot replace it.
            await authority.recordIndexReceipt(original, receipt, session);
            entry.state = 'ready';
            const updated = await File.updateOne(
              filter,
              {
                $set: { managedRetrieval: managedRetrievalStateSchema.parse(state) },
                $inc: { retentionRevision: 1 },
              },
              { session, timestamps: false },
            );
            if (updated.matchedCount !== 1 || Date.now() >= original.workDeadline) unavailable();
          },
          {
            readConcern: { level: 'snapshot' },
            writeConcern: { w: 'majority', j: true },
            maxCommitTimeMS: 5_000,
          },
        );
      } finally {
        await session.endSession();
      }
    },
    async acknowledgePurge(value, authenticatedPeer) {
      canonicalManagedJson(value);
      const request = requestSchema.parse(JSON.parse(canonicalManagedJson(value)));
      const peer = peerSchema.parse(authenticatedPeer);
      const scope = fileSourceScope(request.owner);
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(
          async () => {
            const original = await authority.original(request, session);
            if (
              original.purpose !== 'purge' ||
              original.sources.length !== 1 ||
              original.policy.backendIdentity !== peer.backendIdentity ||
              !equal(original.owner, request.owner) ||
              original.operationId !== request.operationId ||
              request.receipt.completedAt < Math.floor(original.admittedAt / 1000) ||
              request.receipt.completedAt >= Math.floor(original.workDeadline / 1000)
            )
              unavailable();
            const source = original.sources[0];
            const expectedBody = {
              version: 1,
              purgeOperationId: original.operationId,
              keys: source.keys,
              writerEpoch: original.policy.writerEpoch,
            };
            if (sha(canonicalManagedJson(expectedBody)) !== original.bodySha256) unavailable();
            const filter = {
              $and: [
                scope,
                {
                  tenantId: { $exists: true },
                  file_id: source.fileId,
                  retentionAcceptedAt: { $ne: null },
                },
              ],
            };
            const rows = await File.find(filter)
              .select('+managedRetrieval')
              .session(session)
              .lean<IMongoFile[]>();
            if (rows.length !== 1) unavailable();
            const row = rows[0];
            const state = managedRetrievalStateSchema.parse(row.managedRetrieval);
            if (
              !equal(state.revision?.owner, request.owner) ||
              state.revision?.source.fileId !== source.fileId
            )
              unavailable();
            const assigned = state.obligations.filter(
              (entry) => entry.purgeOperationId === original.operationId,
            );
            if (
              assigned.length !== source.keys.length ||
              source.keys.some(
                (key) => assigned.filter((entry) => equal(entry.key, key)).length !== 1,
              )
            )
              unavailable();
            for (const entry of assigned) {
              if (
                !['purge_pending', 'purged'].includes(entry.state) ||
                entry.backendIdentity !== original.policy.backendIdentity ||
                entry.writerEpoch !== original.policy.writerEpoch
              )
                unavailable();
              await authority.history(request.owner, source.fileId, entry, session);
              const receipt = verifyManagedPurgeReceipt(
                request.receipt,
                entry,
                original.operationId,
                sha,
                source.keys,
              );
              entry.state = 'purged';
              entry.receiptSha256 = receipt.receiptSha256;
            }
            const updated = await File.updateOne(
              filter,
              {
                $set: { managedRetrieval: managedRetrievalStateSchema.parse(state) },
                $inc: { retentionRevision: 1 },
              },
              { session, timestamps: false },
            );
            if (updated.matchedCount !== 1) unavailable();
          },
          {
            readConcern: { level: 'snapshot' },
            writeConcern: { w: 'majority', j: true },
            maxCommitTimeMS: 5_000,
          },
        );
      } finally {
        await session.endSession();
      }
    },
  };
}
