/** Private File-owned original operations. This is not a provider-work ledger or an HTTP API. */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import {
  canonicalManagedJson,
  managedOwnerSchema,
  managedRevisionSchema,
  managedIndexKeySchema,
  managedRetrievalStateSchema,
  verifyManagedRevision,
  managedRetrievalLookupRequestSchema as lookupRequestSchema,
  managedRetrievalLookupResponseSchema as lookupResponseSchema,
} from 'librechat-data-provider';
import type {
  ManagedRetrievalLookupReason,
  ManagedIndexReceipt,
  ManagedPurgeReceipt,
} from 'librechat-data-provider';
import type { Model, ClientSession } from 'mongoose';
import type {
  FileRetrievalOriginal,
  FileRetrievalPolicySnapshot,
  FileRetrievalRequest,
  Source,
} from './fileRetrievalOperationContract';
import type { IMongoFile } from '~/types';
import {
  id,
  digest,
  integer,
  purgeRequestSchema,
  requestSchema,
  policySchema,
  parseFileRetrievalPolicySnapshot,
} from './fileRetrievalOperationContract';
import {
  admitManagedFileRetrievalInventory,
  managedFileRetrievalDeletionSettled,
} from './fileRetrieval';
import { createFileRetrievalAcknowledgements } from './fileRetrievalAcknowledgement';
import { fileSourceScope, liveFileFilter } from './fileRetention';
export { parseFileRetrievalPolicySnapshot } from './fileRetrievalOperationContract';
export type {
  FileRetrievalOriginal,
  FileRetrievalPolicy,
  FileRetrievalPolicySnapshot,
  FileRetrievalRequest,
} from './fileRetrievalOperationContract';

type Stored = {
  tenantId: string | null;
  userId: string;
  operationId: string;
  original: FileRetrievalOriginal;
  indexReceipt?: ManagedIndexReceipt;
};
const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const fingerprint = (value: unknown) => sha(canonicalManagedJson(value));
const fail: (code: string) => never = (code: string): never => {
  throw Object.assign(new Error('Managed retrieval admission unavailable'), { code });
};
const equal = (a: unknown, b: unknown) => canonicalManagedJson(a) === canonicalManagedJson(b);
const snapshot = <T>(value: T): T => JSON.parse(canonicalManagedJson(value));
const intent = ({
  admittedAt: _a,
  workDeadline: _w,
  cleanupDeadline: _c,
  originalSha256: _h,
  ...rest
}: FileRetrievalOriginal) => rest;

const lookupPeerSchema = z.object({ backendIdentity: id }).strict();
const seconds = (value: number) => Math.floor(integer.parse(value) / 1000);
export type FileRetrievalLookup = z.infer<typeof lookupResponseSchema>;

/** Factory options are trusted server composition, never request fields. Missing policy denies admission. */
export function createFileRetrievalOperationOwner(
  mongoose: typeof import('mongoose'),
  options: { policySnapshot?: FileRetrievalPolicySnapshot } = {},
): {
  initialize(): Promise<void>;
  admit(value: FileRetrievalRequest): Promise<FileRetrievalOriginal>;
  lookup(
    value: unknown,
    peer: { backendIdentity: string },
    signal?: AbortSignal,
    deadlineAt?: number,
  ): Promise<FileRetrievalLookup>;
  admitPurge(value: {
    owner: FileRetrievalRequest['owner'];
    fileId: string;
  }): Promise<FileRetrievalOriginal[]>;
  acknowledgeIndex(
    value: {
      owner: FileRetrievalRequest['owner'];
      operationId: string;
      receipt: ManagedIndexReceipt;
    },
    peer: { backendIdentity: string },
  ): Promise<void>;
  acknowledgePurge(
    value: {
      owner: FileRetrievalRequest['owner'];
      operationId: string;
      receipt: ManagedPurgeReceipt;
    },
    peer: { backendIdentity: string },
  ): Promise<void>;
} {
  // Parse/copy once. No executable resolver or caller policy can enter the lookup lifetime.
  let trusted: FileRetrievalPolicySnapshot | undefined;
  try {
    const supplied = z.object({ policySnapshot: z.unknown() }).strict().parse(options);
    trusted = parseFileRetrievalPolicySnapshot(supplied.policySnapshot);
  } catch {
    trusted = undefined;
  }
  const policies = new Map(
    trusted?.purge.map(
      (policy) =>
        [
          canonicalManagedJson([policy.backendIdentity, policy.writerEpoch]),
          Object.freeze(policy),
        ] as const,
    ),
  );
  if (trusted) {
    Object.freeze(trusted.content);
    Object.freeze(trusted.source);
    Object.freeze(trusted.purge);
    Object.freeze(trusted);
  }
  const selectPolicy = (
    purpose: FileRetrievalOriginal['purpose'],
    backendIdentity?: string,
    writerEpoch?: number,
  ) => {
    const selected =
      purpose === 'purge'
        ? policies.get(canonicalManagedJson([backendIdentity ?? null, writerEpoch ?? null]))
        : trusted?.content;
    return selected ? snapshot(selected) : undefined;
  };
  const S = mongoose.Schema;
  const schema = new S<Stored>(
    {
      tenantId: { type: String, default: null, immutable: true },
      userId: { type: String, required: true, immutable: true },
      operationId: { type: String, required: true, immutable: true },
      original: { type: S.Types.Mixed, required: true, immutable: true },
      indexReceipt: { type: S.Types.Mixed, required: false, select: false },
    },
    { versionKey: false, strict: 'throw' },
  );
  schema.index(
    { tenantId: 1, userId: 1, operationId: 1 },
    { unique: true, name: 'file_retrieval_original' },
  );
  schema.index({ tenantId: 1, userId: 1, 'original.sources.fileId': 1 });
  // No TTL, overwrite, purge or reclaim API: originals remain charged until a separately reconciled contract.
  const Operation = (mongoose.models.FileRetrievalOperation ??
    mongoose.model<Stored>('FileRetrievalOperation', schema)) as Model<Stored>;
  const File = mongoose.models.File as Model<IMongoFile>;
  let initialized = false;

  async function initialize(): Promise<void> {
    await Operation.init();
    initialized = true;
  }

  function verifyOriginal(original: FileRetrievalOriginal): FileRetrievalOriginal {
    if (!original || original.version !== 1) fail('managed_retrieval_history_unavailable');
    const { originalSha256, ...payload } = original;
    if (originalSha256 !== fingerprint(payload)) fail('managed_retrieval_history_unavailable');
    managedOwnerSchema.parse(original.owner);
    policySchema.parse(original.policy);
    id.parse(original.operationId);
    digest.parse(original.bodySha256);
    integer.parse(original.admittedAt);
    integer.parse(original.workDeadline);
    integer.parse(original.cleanupDeadline);
    if (
      original.workDeadline <= original.admittedAt ||
      original.cleanupDeadline !== original.workDeadline + 900_000 ||
      !Array.isArray(original.sources) ||
      !original.sources.length ||
      original.sources.length > 32
    )
      fail('managed_retrieval_history_unavailable');
    return original;
  }
  async function indexHistory(
    owner: FileRetrievalRequest['owner'],
    fileId: string,
    entry: z.infer<typeof managedRetrievalStateSchema>['obligations'][number],
    session: ClientSession,
    history?: Map<string, Stored>,
  ) {
    const record = history
      ? history.get(entry.operationId)
      : await Operation.findOne({
          tenantId: owner.tenantId,
          userId: owner.userId,
          operationId: entry.operationId,
        })
          .session(session)
          .lean<Stored>();
    if (!record) fail('managed_retrieval_history_unavailable');
    const original = verifyOriginal(record!.original);
    if (
      original.purpose !== 'index' ||
      !equal(original.owner, owner) ||
      original.operationId !== entry.operationId ||
      original.bodySha256 !== entry.requestSha256 ||
      original.policy.backendIdentity !== entry.backendIdentity ||
      original.policy.writerEpoch !== entry.writerEpoch ||
      original.policy.indexGeneration !== entry.key.indexGeneration
    )
      fail('managed_retrieval_history_unavailable');
    const matches = original.sources.filter((source) => source.fileId === fileId);
    if (matches.length !== 1) fail('managed_retrieval_history_unavailable');
    const source = matches[0];
    if (!Array.isArray(source.revisions) || source.revisions.length !== source.keys.length)
      fail('managed_retrieval_history_unavailable');
    const indexes = source.keys.flatMap((key, index) => (equal(key, entry.key) ? [index] : []));
    if (indexes.length !== 1) fail('managed_retrieval_history_unavailable');
    let revision: z.infer<typeof managedRevisionSchema>;
    try {
      revision = verifyManagedRevision(source.revisions[indexes[0]], sha);
    } catch {
      return fail('managed_retrieval_history_unavailable');
    }
    if (
      !equal(revision.owner, owner) ||
      revision.source.fileId !== fileId ||
      revision.sourceRevision !== entry.key.sourceRevision ||
      revision.representationRevision !== entry.key.representationRevision
    )
      fail('managed_retrieval_history_unavailable');
    integer.parse(source.expiresAt);
    return { revision: snapshot(revision), expiresAt: source.expiresAt };
  }

  async function admit(value: FileRetrievalRequest): Promise<FileRetrievalOriginal> {
    canonicalManagedJson(value);
    const request = snapshot(requestSchema.parse(value));
    const firstAdmission = Date.now();
    const scope = fileSourceScope(request.owner);
    const selected = selectPolicy(request.purpose);
    if (!selected) fail('managed_retrieval_policy_unavailable');
    canonicalManagedJson(selected);
    const policy = policySchema.parse(selected);
    if (request.purpose === 'query' && !policy.rankingPolicySha256)
      fail('managed_retrieval_policy_unavailable');
    if (!initialized) fail('managed_retrieval_store_uninitialized');
    const ownerKey = { tenantId: request.owner.tenantId, userId: request.owner.userId };
    const operationKey = { ...ownerKey, operationId: request.operationId };
    const bodySha256 = fingerprint(request.body);
    const orderedWrites = [...request.fileIds].sort();
    const session = await mongoose.startSession();
    try {
      let result: FileRetrievalOriginal | undefined;
      await session.withTransaction(
        async () => {
          const existing = await Operation.findOne(operationKey).session(session).lean<Stored>();
          const rows = await File.find({
            $and: [
              scope,
              {
                tenantId: { $exists: true },
                file_id: { $in: request.fileIds },
                retentionAcceptedAt: { $ne: null },
              },
              liveFileFilter(),
            ],
          })
            .select('+managedRetrieval +retrievalCreation')
            .session(session)
            .lean<IMongoFile[]>();
          if (rows.length !== request.fileIds.length) fail('managed_retrieval_source_unavailable');
          const byId = new Map(rows.map((row) => [row.file_id, row]));
          const states = new Map<string, ReturnType<typeof managedRetrievalStateSchema.parse>>();
          const sources: Source[] = request.fileIds.map((fileId) => {
            const row = byId.get(fileId)!;
            const state = managedRetrievalStateSchema.parse(row.managedRetrieval);
            if (!state.revision) fail('managed_retrieval_source_unavailable');
            const revision = verifyManagedRevision(state.revision!, sha);
            if (!equal(revision.owner, request.owner) || revision.source.fileId !== fileId)
              fail('managed_retrieval_source_unavailable');
            const expiresAt = new Date(row.expiredAt!).getTime();
            if (
              !Number.isSafeInteger(expiresAt) ||
              expiresAt < 0 ||
              row.deletionRequestedAt ||
              row.deletionCompletedAt ||
              expiresAt <= Date.now()
            )
              fail('managed_retrieval_source_unavailable');
            const key = {
              sourceRevision: revision.sourceRevision,
              representationRevision: revision.representationRevision,
              indexGeneration: policy.indexGeneration,
            };
            const liabilities = state.obligations.filter(
              (entry) => entry.backendIdentity === policy.backendIdentity,
            );
            const keys = [key];
            if (
              !keys.length ||
              (request.purpose === 'query' &&
                !liabilities.some((entry) => equal(entry.key, key) && entry.state === 'ready'))
            )
              fail('managed_retrieval_source_unavailable');
            states.set(fileId, state);
            return {
              fileId,
              sourceRevision: revision.sourceRevision,
              representationRevision: revision.representationRevision,
              expiresAt,
              keys,
              revisions: [snapshot(revision)],
            };
          });
          const keys = sources.flatMap((source) => source.keys);
          if (keys.length > 32 || new Set(keys.map(canonicalManagedJson)).size !== keys.length)
            fail('managed_retrieval_key_capacity');
          const admittedAt = existing?.original.admittedAt ?? firstAdmission;
          const workDeadline = Math.min(
            admittedAt + (request.purpose === 'query' ? 120_000 : 900_000),
            ...sources.map((s) => s.expiresAt),
          );
          const payload = {
            version: 1 as const,
            owner: request.owner,
            operationId: request.operationId,
            purpose: request.purpose,
            bodySha256,
            policy,
            sources,
            admittedAt,
            workDeadline,
            cleanupDeadline: workDeadline + 900_000,
          };
          const original: FileRetrievalOriginal = {
            ...payload,
            originalSha256: fingerprint(payload),
          };
          if (
            existing &&
            (!equal(intent(existing.original), intent(original)) ||
              !equal(existing.original, original))
          )
            fail('managed_retrieval_original_mismatch');
          if (Date.now() >= original.workDeadline) fail('managed_retrieval_original_expired');

          for (const fileId of orderedWrites) {
            const row = byId.get(fileId)!;
            const state = states.get(fileId)!;
            const retrievalCreation = admitManagedFileRetrievalInventory(row);
            if (!existing) {
              // This count is serialized by the write below to the SAME File row. Every operation,
              // including repeated queries to one index key, permanently consumes one membership.
              const count = await Operation.countDocuments({
                ...ownerKey,
                'original.sources.fileId': fileId,
                'original.purpose': { $in: ['index', 'query'] },
              }).session(session);
              if (count >= 64) fail('managed_retrieval_work_capacity');
            }
            if (request.purpose === 'index') {
              const key = sources.find((source) => source.fileId === fileId)!.keys[0];
              const prior = state.obligations.find(
                (entry) =>
                  entry.backendIdentity === policy.backendIdentity && equal(entry.key, key),
              );
              if (
                prior &&
                (prior.operationId !== request.operationId ||
                  prior.requestSha256 !== bodySha256 ||
                  prior.writerEpoch !== policy.writerEpoch)
              )
                fail('managed_retrieval_original_mismatch');
              if (!prior) {
                if (state.obligations.length >= 64) fail('managed_retrieval_obligation_capacity');
                state.obligations.push({
                  key,
                  backendIdentity: policy.backendIdentity,
                  operationId: request.operationId,
                  requestSha256: bodySha256,
                  writerEpoch: policy.writerEpoch,
                  state: 'preparing',
                });
              }
            }
            const updated = managedRetrievalStateSchema.parse(state);
            const touched = await File.updateOne(
              {
                $and: [
                  scope,
                  { _id: row._id, file_id: fileId, tenantId: { $exists: true } },
                  liveFileFilter(),
                ],
              },
              {
                $inc: { retentionRevision: 1 },
                $set: {
                  managedRetrieval: updated,
                  ...(retrievalCreation === undefined ? {} : { retrievalCreation }),
                },
              },
              { session, timestamps: false },
            );
            if (touched.matchedCount !== 1) fail('managed_retrieval_source_unavailable');
          }
          if (!existing) await Operation.create([{ ...operationKey, original }], { session });
          if (Date.now() >= workDeadline) fail('managed_retrieval_original_expired');
          result = snapshot(existing?.original ?? original);
        },
        {
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority', j: true },
          maxCommitTimeMS: 5_000,
        },
      );
      if (!result) fail('managed_retrieval_commit_unknown');
      return result!;
    } finally {
      await session.endSession();
    }
  }
  async function admitPurge(value: {
    owner: FileRetrievalRequest['owner'];
    fileId: string;
  }): Promise<FileRetrievalOriginal[]> {
    canonicalManagedJson(value);
    const request = snapshot(purgeRequestSchema.parse(value));
    if (!trusted) fail('managed_retrieval_policy_unavailable');
    const firstP = Date.now();
    const scope = fileSourceScope(request.owner);
    if (!initialized) fail('managed_retrieval_store_uninitialized');
    const ownerKey = { tenantId: request.owner.tenantId, userId: request.owner.userId };
    const session = await mongoose.startSession();
    try {
      let result: FileRetrievalOriginal[] | undefined;
      await session.withTransaction(
        async () => {
          const rows = await File.find({
            $and: [
              scope,
              {
                tenantId: { $exists: true },
                file_id: request.fileId,
                retentionAcceptedAt: { $ne: null },
              },
            ],
          })
            .select('+managedRetrieval +retrievalCreation')
            .session(session)
            .lean<IMongoFile[]>();
          if (rows.length !== 1 || rows[0].file_id !== request.fileId)
            fail('managed_retrieval_source_unavailable');
          const row = rows[0];
          if (row.managedRetrieval === undefined && managedFileRetrievalDeletionSettled(row)) {
            result = [];
            return;
          }
          const state = managedRetrievalStateSchema.parse(row.managedRetrieval);
          if (
            !equal(state.revision?.owner ?? state.legacy?.owner, request.owner) ||
            (state.revision?.source.fileId ?? state.legacy?.fileId) !== request.fileId
          )
            fail('managed_retrieval_source_unavailable');
          if (!state.obligations.length) {
            if (!managedFileRetrievalDeletionSettled(row))
              fail('managed_retrieval_inventory_unresolved');
            result = [];
            return;
          }
          if (!state.revision) fail('managed_retrieval_source_unavailable');
          const revision = verifyManagedRevision(state.revision!, sha);
          if (!equal(revision.owner, request.owner) || revision.source.fileId !== request.fileId)
            fail('managed_retrieval_source_unavailable');
          const expiresAt = new Date(row.expiredAt!).getTime();
          if (!Number.isSafeInteger(expiresAt) || expiresAt < 0)
            fail('managed_retrieval_source_unavailable');
          const slotId = (entry: (typeof state.obligations)[number]) =>
            fingerprint({
              owner: request.owner,
              fileId: request.fileId,
              backendIdentity: entry.backendIdentity,
              key: entry.key,
              operationId: entry.operationId,
              writerEpoch: entry.writerEpoch,
            });
          const sortKey = (entry: (typeof state.obligations)[number]) =>
            canonicalManagedJson({
              backendIdentity: entry.backendIdentity,
              writerEpoch: entry.writerEpoch,
              key: entry.key,
            });
          const entries = [...state.obligations].sort((a, b) => {
            if (sortKey(a) < sortKey(b)) return -1;
            if (sortKey(a) > sortKey(b)) return 1;
            return 0;
          });
          const histories = new Map<string, Awaited<ReturnType<typeof indexHistory>>>();
          for (const entry of entries)
            histories.set(
              slotId(entry),
              await indexHistory(request.owner, request.fileId, entry, session),
            );
          const originals: FileRetrievalOriginal[] = [];
          for (const operationId of [
            ...new Set(
              entries.flatMap((entry) => (entry.purgeOperationId ? [entry.purgeOperationId] : [])),
            ),
          ].sort()) {
            const stored = await Operation.findOne({ ...ownerKey, operationId })
              .session(session)
              .lean<Stored>();
            if (!stored) fail('managed_retrieval_cleanup_mismatch');
            const original = stored!.original;
            const assigned = entries.filter((entry) => entry.purgeOperationId === operationId);
            const { originalSha256, ...payload } = original;
            if (
              original.purpose !== 'purge' ||
              original.operationId !== operationId ||
              !equal(original.owner, request.owner) ||
              original.sources.length !== 1 ||
              original.sources[0].fileId !== request.fileId ||
              !equal(
                original.sources[0].revisions,
                assigned.map((entry) => histories.get(slotId(entry))!.revision),
              ) ||
              !equal(
                original.sources[0].keys,
                assigned.map((entry) => entry.key),
              ) ||
              !equal(original.cleanup?.slotIds, assigned.map(slotId)) ||
              assigned.some(
                (entry) =>
                  entry.backendIdentity !== original.policy.backendIdentity ||
                  entry.writerEpoch !== original.policy.writerEpoch,
              ) ||
              originalSha256 !== fingerprint(payload) ||
              original.workDeadline !== original.admittedAt + 900_000 ||
              original.cleanupDeadline !== original.workDeadline + 900_000
            )
              fail('managed_retrieval_cleanup_mismatch');
            // File owns the retained terminal receipt. A complete partition needs no replay,
            // even after its dispatch clock expires. The original itself remains immutable.
            const terminal = assigned.filter((entry) => entry.state === 'purged');
            if (terminal.length) {
              if (
                terminal.length !== assigned.length ||
                new Set(terminal.map((entry) => entry.receiptSha256)).size !== 1
              )
                fail('managed_retrieval_cleanup_mismatch');
              continue;
            }
            // Pending recovery exposes original metadata, including expired clocks; no new deadline.
            originals.push(snapshot(original));
          }
          const unclaimed = entries.filter((entry) => !entry.purgeOperationId);
          const groups = new Map<string, typeof entries>();
          for (const entry of unclaimed) {
            const group = canonicalManagedJson({
              backendIdentity: entry.backendIdentity,
              writerEpoch: entry.writerEpoch,
            });
            groups.set(group, [...(groups.get(group) ?? []), entry]);
          }
          const partitions: (typeof entries)[] = [];
          for (const group of [...groups.keys()].sort()) {
            const entries = groups.get(group)!;
            for (let offset = 0; offset < entries.length; offset += 32)
              partitions.push(entries.slice(offset, offset + 32));
          }
          const planSha256 = fingerprint({
            owner: request.owner,
            fileId: request.fileId,
            slots: unclaimed.map(slotId),
          });
          if (partitions.length) {
            const priorCount = await Operation.countDocuments({
              ...ownerKey,
              'original.sources.fileId': request.fileId,
              'original.purpose': { $in: ['purge'] },
            }).session(session);
            if (priorCount + partitions.length > 64) fail('managed_retrieval_cleanup_capacity');
          }
          for (let index = 0; index < partitions.length; index++) {
            const partition = partitions[index];
            const { backendIdentity, writerEpoch } = partition[0];
            if (writerEpoch >= Number.MAX_SAFE_INTEGER) fail('managed_retrieval_epoch_mismatch');
            const selected = selectPolicy('purge', backendIdentity, writerEpoch);
            if (!selected) fail('managed_retrieval_policy_unavailable');
            canonicalManagedJson(selected);
            const policy = policySchema.parse(selected);
            if (policy.backendIdentity !== backendIdentity || policy.writerEpoch !== writerEpoch)
              fail('managed_retrieval_epoch_mismatch');
            const slotIds = partition.map(slotId);
            const operationId = `purge-${fingerprint({ owner: request.owner, fileId: request.fileId, slotIds })}`;
            if (
              await Operation.findOne({ ...ownerKey, operationId })
                .session(session)
                .lean()
            )
              fail('managed_retrieval_cleanup_mismatch');
            const keys = partition.map((entry) => entry.key);
            const payload = {
              version: 1 as const,
              owner: request.owner,
              operationId,
              purpose: 'purge' as const,
              bodySha256: fingerprint({
                version: 1,
                purgeOperationId: operationId,
                keys,
                writerEpoch,
              }),
              policy,
              sources: [
                {
                  fileId: request.fileId,
                  sourceRevision: revision.sourceRevision,
                  representationRevision: revision.representationRevision,
                  expiresAt,
                  keys,
                  revisions: partition.map((entry) => histories.get(slotId(entry))!.revision),
                },
              ],
              admittedAt: firstP,
              workDeadline: firstP + 900_000,
              cleanupDeadline: firstP + 1_800_000,
              cleanup: { slotIds, planSha256, partition: index, partitions: partitions.length },
            };
            const original: FileRetrievalOriginal = {
              ...payload,
              originalSha256: fingerprint(payload),
            };
            await Operation.create([{ ...ownerKey, operationId, original }], { session });
            for (const entry of partition) {
              entry.purgeOperationId = operationId;
              entry.state = 'purge_pending';
            }
            originals.push(original);
          }
          if (partitions.length && Date.now() >= firstP + 900_000)
            fail('managed_retrieval_original_expired');
          const touched = await File.updateOne(
            {
              $and: [scope, { _id: row._id, file_id: request.fileId, tenantId: { $exists: true } }],
            },
            {
              $inc: { retentionRevision: 1 },
              $set: { managedRetrieval: managedRetrievalStateSchema.parse(state) },
            },
            { session, timestamps: false },
          );
          if (touched.matchedCount !== 1) fail('managed_retrieval_source_unavailable');
          // Stable response order also survives a lost acknowledgement and arbitrary File array ordering.
          result = snapshot(
            originals.sort((a, b) => {
              if (a.operationId < b.operationId) return -1;
              if (a.operationId > b.operationId) return 1;
              return 0;
            }),
          );
        },
        {
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority', j: true },
          maxCommitTimeMS: 5_000,
        },
      );
      if (!result) fail('managed_retrieval_commit_unknown');
      return result!;
    } finally {
      await session.endSession();
    }
  }

  /** Peer identity is supplied by the authenticated internal listener, never the request body. */
  async function lookup(
    value: unknown,
    peerValue: { backendIdentity: string },
    parentSignal?: AbortSignal,
    deadlineAt?: number,
  ): Promise<FileRetrievalLookup> {
    canonicalManagedJson(value);
    const request = lookupRequestSchema.parse(value);
    const peer = lookupPeerSchema.parse(peerValue);
    const unavailable = (reason: ManagedRetrievalLookupReason): FileRetrievalLookup => ({
      version: 1,
      status: 'unavailable',
      reason,
    });
    if (request.requestedPurpose === 'status') return unavailable('status_contract_unselected');
    if (!initialized) return unavailable('not_found');
    if (!trusted) return unavailable('policy_unavailable');
    // Use only an already connected existing client: Mongoose.startSession buffers connection waits.
    if (
      !parentSignal ||
      typeof deadlineAt !== 'number' ||
      !Number.isSafeInteger(deadlineAt) ||
      parentSignal.aborted ||
      deadlineAt <= Date.now() ||
      deadlineAt - Date.now() > 120_000 ||
      mongoose.connection?.readyState !== 1
    )
      return unavailable('source_unavailable');
    const client = mongoose.connection.getClient();
    const database = client.db(Operation.db.name);
    const controller = new AbortController();
    const abort = () => controller.abort(parentSignal.reason);
    parentSignal.addEventListener('abort', abort, { once: true });
    const until = performance.now() + deadlineAt - Date.now();
    const remaining = () => {
      controller.signal.throwIfAborted();
      const milliseconds = Math.floor(until - performance.now());
      if (milliseconds <= 0) {
        controller.abort(new Error('Lookup deadline expired'));
        controller.signal.throwIfAborted();
      }
      return milliseconds;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let session: ClientSession;
    try {
      timer = setTimeout(() => controller.abort(new Error('Lookup deadline expired')), remaining());
      timer.unref();
      session = client.startSession({ defaultTimeoutMS: Math.min(2_000, remaining()) });
    } catch (error) {
      clearTimeout(timer);
      parentSignal.removeEventListener('abort', abort);
      throw error;
    }
    // Single-batch native commands have no cursor/getMore actor or Mongoose buffering.
    // Each driver command owns the SAME cancellation signal and remaining original budget.
    const read = async <T>(
      model: Model<T>,
      filter: unknown,
      maximum: number,
      projection?: Record<string, number>,
    ) => {
      const cast = model.find(filter as never).cast(model);
      // Read only the model metadata; the original native command below retains its tenant-bound filter.
      const { name: collectionName } = model.collection;
      const response = await database.command(
        {
          find: collectionName,
          filter: cast,
          singleBatch: true,
          limit: maximum,
          batchSize: maximum,
          ...(projection ? { projection } : {}),
        },
        { session, signal: controller.signal, timeoutMS: Math.min(2_000, remaining()) },
      );
      remaining();
      if (
        !response.cursor ||
        !Array.isArray(response.cursor.firstBatch) ||
        !(response.cursor.id === 0 || response.cursor.id?.isZero?.()) ||
        response.cursor.firstBatch.length > maximum
      )
        fail('managed_retrieval_history_unavailable');
      return response.cursor.firstBatch;
    };
    let result: FileRetrievalLookup = unavailable('not_found');
    let failure: unknown;
    try {
      session.startTransaction({ readConcern: { level: 'snapshot' } });
      await (async () => {
        result = unavailable('not_found');
        const found = await read(
          Operation,
          {
            tenantId: request.owner.tenantId,
            userId: request.owner.userId,
            operationId: request.operationId,
          },
          2,
        );
        if (found.length > 1) fail('managed_retrieval_history_unavailable');
        const record = found[0] as Stored | undefined;
        if (!record) return;
        const original = verifyOriginal(record.original);
        if (!equal(original.owner, request.owner) || original.operationId !== request.operationId)
          return;
        if (original.policy.backendIdentity !== peer.backendIdentity) {
          result = unavailable('backend_mismatch');
          return;
        }
        if (original.purpose !== request.requestedPurpose) {
          result = unavailable('purpose_mismatch');
          return;
        }
        if (Date.now() >= original.workDeadline) {
          result = unavailable('original_expired');
          return;
        }
        const selected = selectPolicy(
          original.purpose,
          original.policy.backendIdentity,
          original.policy.writerEpoch,
        );
        if (!selected || !equal(policySchema.parse(selected), original.policy)) {
          result = unavailable('policy_unavailable');
          return;
        }
        const scope = fileSourceScope(request.owner);
        const fileIds = original.sources.map((source) => source.fileId);
        if (new Set(fileIds).size !== fileIds.length) fail('managed_retrieval_history_unavailable');
        const baseFilter = {
          $and: [
            scope,
            {
              file_id: { $in: fileIds },
              tenantId: { $exists: true },
              retentionAcceptedAt: { $ne: null },
            },
          ],
        };
        const rows = (await read(File, baseFilter, 33, {
          file_id: 1,
          user: 1,
          tenantId: 1,
          expiredAt: 1,
          deletionRequestedAt: 1,
          deletionCompletedAt: 1,
          managedRetrieval: 1,
        })) as IMongoFile[];
        if (rows.length !== fileIds.length) {
          result = unavailable('source_unavailable');
          return;
        }
        if (original.purpose !== 'purge') {
          const live = (await read(File, { $and: [baseFilter, liveFileFilter()] }, 33, {
            file_id: 1,
          })) as IMongoFile[];
          if (
            live.length !== fileIds.length ||
            live.some((row) => !fileIds.includes(row.file_id))
          ) {
            result = unavailable('source_unavailable');
            return;
          }
        }
        const historyIds = [
          ...new Set(
            rows.flatMap((row) => {
              const state = managedRetrievalStateSchema.parse(row.managedRetrieval);
              const source = original.sources.find((item) => item.fileId === row.file_id);
              return state.obligations
                .filter(
                  (entry) =>
                    entry.backendIdentity === peer.backendIdentity &&
                    source?.keys.some((key) => equal(key, entry.key)),
                )
                .map((entry) => entry.operationId);
            }),
          ),
        ];
        if (!historyIds.length || historyIds.length > 32)
          fail('managed_retrieval_history_unavailable');
        const historyRows = (await read(
          Operation,
          {
            tenantId: request.owner.tenantId,
            userId: request.owner.userId,
            operationId: { $in: historyIds },
          },
          33,
        )) as Stored[];
        const history = new Map(historyRows.map((record) => [record.operationId, record]));
        if (history.size !== historyRows.length || history.size !== historyIds.length)
          fail('managed_retrieval_history_unavailable');
        const projected: Extract<FileRetrievalLookup, { status: 'available' }>['sources'] = [];
        for (const source of original.sources) {
          const row = rows.find((item) => item.file_id === source.fileId);
          if (
            !row ||
            String(row.user) !== request.owner.userId ||
            row.tenantId !== request.owner.tenantId
          )
            fail('managed_retrieval_history_unavailable');
          const state = managedRetrievalStateSchema.parse(row.managedRetrieval);
          if (!Array.isArray(source.revisions) || source.revisions.length !== source.keys.length)
            fail('managed_retrieval_history_unavailable');
          const currentExpiry = new Date(row.expiredAt!).getTime();
          integer.parse(currentExpiry);
          for (let i = 0; i < source.keys.length; i++) {
            const key = managedIndexKeySchema.parse(source.keys[i]);
            const entries = state.obligations.filter(
              (entry) => entry.backendIdentity === peer.backendIdentity && equal(entry.key, key),
            );
            if (entries.length !== 1) fail('managed_retrieval_history_unavailable');
            const entry = entries[0];
            if (
              original.purpose === 'index' &&
              (entry.operationId !== original.operationId ||
                entry.requestSha256 !== original.bodySha256)
            )
              fail('managed_retrieval_history_unavailable');
            const retained = await indexHistory(
              request.owner,
              source.fileId,
              entry,
              session,
              history,
            );
            if (
              !equal(retained.revision, source.revisions[i]) ||
              entry.writerEpoch !== original.policy.writerEpoch
            )
              fail('managed_retrieval_history_unavailable');
            if (original.purpose === 'purge' && entry.purgeOperationId !== original.operationId)
              fail('managed_retrieval_history_unavailable');
            let contentState: 'revoked' | 'expired' | 'revision_mismatch' | 'live';
            if (row.deletionRequestedAt || row.deletionCompletedAt) contentState = 'revoked';
            else if (currentExpiry <= Date.now()) contentState = 'expired';
            else if (!equal(state.revision, retained.revision)) contentState = 'revision_mismatch';
            else contentState = 'live';
            if (
              original.purpose !== 'purge' &&
              (contentState !== 'live' ||
                (original.purpose === 'query'
                  ? entry.state !== 'ready'
                  : !['preparing', 'ready'].includes(entry.state)))
            ) {
              result = unavailable('source_unavailable');
              return;
            }
            projected.push({
              key,
              revision: retained.revision,
              originalExpiresAt: seconds(Math.min(source.expiresAt, retained.expiresAt)),
              currentExpiresAt: seconds(currentExpiry),
              contentState,
              indexOriginal: {
                operationId: entry.operationId,
                requestSha256: entry.requestSha256,
                writerEpoch: entry.writerEpoch,
                backendIdentity: entry.backendIdentity,
                state: entry.state,
              },
            });
          }
        }
        if (
          !projected.length ||
          projected.length > 32 ||
          new Set(projected.map((entry) => canonicalManagedJson(entry.key))).size !==
            projected.length
        )
          fail('managed_retrieval_history_unavailable');
        // Historical index expiry is provenance; the live File governs this operation's sources.
        // Its original work/cleanup clocks remain fixed and are checked independently.
        const sourceExpiresAt =
          original.purpose === 'purge'
            ? null
            : Math.min(...projected.map((entry) => entry.currentExpiresAt!));
        if (sourceExpiresAt !== null && Math.floor(Date.now() / 1000) >= sourceExpiresAt) {
          result = unavailable('source_unavailable');
          return;
        }
        const workDeadline = seconds(original.workDeadline);
        if (Math.floor(Date.now() / 1000) >= workDeadline) {
          result = unavailable('original_expired');
          return;
        }
        result = lookupResponseSchema.parse({
          version: 1,
          status: 'available',
          timeUnit: 'unix-seconds',
          owner: original.owner,
          operationId: original.operationId,
          original: {
            purpose: original.purpose,
            originalSha256: original.originalSha256,
            bodySha256: original.bodySha256,
            backendIdentity: original.policy.backendIdentity,
            writerEpoch: original.policy.writerEpoch,
            routePolicySha256: original.policy.routePolicySha256,
            rankingPolicySha256: original.policy.rankingPolicySha256,
            indexGeneration: original.policy.indexGeneration,
            policyProvenanceSha256: original.policy.provenanceSha256,
            admittedAt: seconds(original.admittedAt),
            workDeadline,
            technicalCleanupDeadline: seconds(original.cleanupDeadline),
          },
          authority: {
            purpose: original.purpose,
            requestSha256: original.bodySha256,
            writerEpoch: original.policy.writerEpoch,
            workDeadline,
            routePolicySha256: original.policy.routePolicySha256,
            sourceExpiresAt,
            cleanupDeadline: original.purpose === 'purge' ? workDeadline : null,
          },
          sources: projected,
        });
      })();
      remaining();
    } catch (error) {
      failure = error;
    } finally {
      clearTimeout(timer);
      parentSignal.removeEventListener('abort', abort);
      // Separate finite settlement budget. endSession awaits abort and releases the session
      // in its finally even on CSOT expiry. Never race/release a still-pending command.
      try {
        await session.endSession({ timeoutMS: 5_000 });
      } catch {
        fail('managed_retrieval_lookup_cleanup_unresolved');
      }
    }
    if (parentSignal.aborted || controller.signal.aborted || performance.now() >= until)
      return unavailable('source_unavailable');
    if (failure) {
      if (
        failure instanceof z.ZodError ||
        (failure as { code?: string }).code?.startsWith('managed_retrieval_')
      )
        return unavailable('history_unavailable');
      throw failure;
    }
    return snapshot(result);
  }

  const acknowledgements = createFileRetrievalAcknowledgements(mongoose, {
    async original(request, session) {
      if (!initialized) fail('managed_retrieval_store_uninitialized');
      const stored = await Operation.findOne({
        tenantId: request.owner.tenantId,
        userId: request.owner.userId,
        operationId: request.operationId,
      })
        .session(session)
        .lean<Stored>();
      if (!stored) fail('managed_retrieval_history_unavailable');
      const original = verifyOriginal(stored!.original);
      const selected = selectPolicy(
        original.purpose,
        original.policy.backendIdentity,
        original.policy.writerEpoch,
      );
      if (!selected || !equal(selected, original.policy))
        fail('managed_retrieval_policy_unavailable');
      return original;
    },
    history: indexHistory,
    async recordIndexReceipt(original, receipt, session) {
      const updated = await Operation.updateOne(
        {
          tenantId: original.owner.tenantId,
          userId: original.owner.userId,
          operationId: original.operationId,
          'original.originalSha256': original.originalSha256,
          $or: [{ indexReceipt: { $exists: false } }, { indexReceipt: receipt }],
        },
        { $set: { indexReceipt: receipt } },
        { session },
      );
      if (updated.matchedCount !== 1) fail('managed_retrieval_acknowledgement_unavailable');
    },
  });
  return { initialize, admit, admitPurge, lookup, ...acknowledgements };
}
