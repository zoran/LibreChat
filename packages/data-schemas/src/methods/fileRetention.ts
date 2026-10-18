/** File lifecycle authority shared by File CRUD and transactional Message admission. */
import {
  UPLOAD_MAX_TEXT_BYTES,
  UPLOAD_DERIVED_MAX_SOURCES,
  UPLOAD_DERIVED_MAX_DESCENDANTS,
  UPLOAD_DERIVED_MAX_ORIGIN_BYTES,
  isUploadPrincipal,
  readUploadSecuritySubject,
  readUploadDerivedIntent,
  readUploadDerivedOrigin,
  uploadDerivedExpiresAt,
  readManagedDocumentResult,
} from 'librechat-data-provider';
import type {
  ManagedDocumentResult,
  UploadDerivedIntent,
  UploadDerivedOrigin,
  UploadDerivedSource,
} from 'librechat-data-provider';
import type { ClientSession, FilterQuery, Model } from 'mongoose';
import type {
  FileOwnerScope,
  FileSourceCopyReservation,
  ManagedUploadAcceptance,
} from '~/types/file';
import type { IMongoFile, SourceRetentionContext } from '~/types';
import type { RetainedTextAllocation } from '~/types/file';
import { adjustRetainedTextBytes, RESOURCE_MAX } from './uploadManagementStore';
import { approvedFileFilter, captureManagedFileApproval } from './fileSecurity';
import { tenantStorage, SYSTEM_TENANT_ID } from '~/config/tenantContext';

/** Covers the BSON receipt and its bounded array-key overhead until File cleanup. */
const COPY_RECEIPT_BYTES = 256;
const MAX_COPY_RECEIPTS = 1024;

export function unreconciledDocumentStorage(): never {
  throw Object.assign(new Error('Document storage is not reconciled.'), {
    code: 'document_inventory_unreconciled',
  });
}

/** File owns copy liabilities; retained consumers own their allocation receipts. Both join the same commit. */
export async function resizeRetainedDerivatives(
  mongoose: typeof import('mongoose'),
  owner: FileOwnerScope,
  previous: readonly RetainedTextAllocation[],
  next: readonly RetainedTextAllocation[],
  session: ClientSession,
): Promise<void> {
  if (!session.inTransaction()) throw new Error('Derivative writes require a transaction');
  const changes = new Map<string, number>();
  for (const [allocations, sign] of [
    [previous, -1],
    [next, 1],
  ] as const) {
    const seen = new Set<string>();
    if (allocations.length > 64) unreconciledDocumentStorage();
    for (const { fileId, bytes } of allocations) {
      if (!fileId || seen.has(fileId) || !Number.isSafeInteger(bytes) || bytes < 0)
        unreconciledDocumentStorage();
      seen.add(fileId);
      changes.set(fileId, (changes.get(fileId) ?? 0) + sign * bytes);
    }
  }
  for (const [id, delta] of changes) if (delta === 0) changes.delete(id);
  if (!changes.size) return;
  const File = mongoose.models.File as Model<IMongoFile>;
  const rows = await File.find({
    ...managedFileScope(owner),
    file_id: { $in: [...changes.keys()] },
    retentionAcceptedAt: { $ne: null },
  })
    .select(
      'file_id retentionAcceptedAt expiredAt deletionRequestedAt deletionCompletedAt +retainedDerivativeBytes',
    )
    .session(session)
    .lean<IMongoFile[]>();
  if (rows.length !== changes.size) throw new FileSourceUnavailableError();
  const now = new Date();
  for (const row of rows) {
    const delta = changes.get(row.file_id)!;
    if (
      !Number.isSafeInteger(row.retainedDerivativeBytes) ||
      row.retainedDerivativeBytes! < 0 ||
      row.retainedDerivativeBytes! + delta < 0
    )
      unreconciledDocumentStorage();
    if (
      delta > 0 &&
      (row.deletionRequestedAt || row.deletionCompletedAt || !row.expiredAt || row.expiredAt <= now)
    )
      throw new FileSourceUnavailableError();
  }
  await adjustRetainedTextBytes(
    mongoose,
    [...changes.values()].reduce((sum, bytes) => sum + bytes, 0),
    session,
  );
  for (const row of rows) {
    await File.updateOne(
      { _id: row._id, ...managedFileScope(owner) },
      {
        $inc: { retainedDerivativeBytes: changes.get(row.file_id)!, retentionRevision: 1 },
      },
      { session, timestamps: false },
    );
  }
}

export class FileSourceUnavailableError extends Error {
  constructor() {
    super('Document source unavailable');
    this.name = 'FileSourceUnavailableError';
  }
}

/** Admission capacity is distinct from revoked sources; retained readers preserve this safe code. */
export class FileSourceCapacityError extends Error {
  readonly code = 'capacity_exceeded';

  constructor() {
    super('Document source capacity exceeded');
    this.name = 'FileSourceCapacityError';
  }
}

export function fileSourceScope(owner: FileOwnerScope): { user: string; tenantId: string | null } {
  const tenant = tenantStorage.getStore()?.tenantId;
  if (
    !owner.userId ||
    (owner.tenantId != null &&
      (typeof owner.tenantId !== 'string' ||
        !/^[a-zA-Z0-9_.-]{1,128}$/.test(owner.tenantId) ||
        owner.tenantId === SYSTEM_TENANT_ID)) ||
    (tenant && tenant !== SYSTEM_TENANT_ID && tenant !== owner.tenantId)
  ) {
    throw new FileSourceUnavailableError();
  }
  return { user: owner.userId, tenantId: owner.tenantId ?? null };
}

/** Retained rows must carry the namespace explicitly; Mongo null equality also matches missing fields. */
function managedFileScope(owner: FileOwnerScope): FilterQuery<IMongoFile> {
  const scope = fileSourceScope(owner);
  return {
    ...scope,
    ...(scope.tenantId === null ? { tenantId: { $eq: null, $exists: true } } : {}),
  };
}

/** Unmanaged files keep upstream semantics. Managed files never outlive original admission. */
export function liveFileFilter(): FilterQuery<IMongoFile> {
  const security = approvedFileFilter();
  const managedOnly = process.env.CORTEX_UPLOAD_MANAGEMENT_ENABLED === 'true';
  return {
    // Draft access belongs to a later explicit Workspace consumer, never native attachments.
    derivedOrigin: { $exists: false },
    $or: [
      ...(!managedOnly
        ? [{ retentionAcceptedAt: null, uploadOperationId: { $exists: false } }]
        : []),
      {
        retentionAcceptedAt: { $ne: null },
        $and: [
          {
            $or: [
              { tenantId: { $type: 10 } },
              {
                tenantId: {
                  $type: 'string',
                  $regex: /^[a-zA-Z0-9_.-]{1,128}$/,
                  $ne: SYSTEM_TENANT_ID,
                },
              },
            ],
          },
        ],
        deletionRequestedAt: null,
        deletionCompletedAt: null,
        expiredAt: { $gt: new Date() },
        $or: [
          ...(!managedOnly ? [{ uploadOperationId: { $exists: false } }] : []),
          { status: 'ready', ...security },
        ],
      },
    ],
  };
}

export async function resolveFileSources(
  mongoose: typeof import('mongoose'),
  owner: FileOwnerScope,
  ids: readonly string[],
  session?: ClientSession,
): Promise<SourceRetentionContext | undefined> {
  const unique = [...new Set(ids)];
  if (!unique.length) return undefined;
  const File = mongoose.models.File as Model<IMongoFile>;
  const rows = await File.find({
    $and: [fileSourceScope(owner), { file_id: { $in: unique } }, liveFileFilter()],
  })
    .session(session ?? null)
    .select('file_id retentionAcceptedAt expiredAt')
    .lean<IMongoFile[]>();
  if (rows.length !== unique.length) throw new FileSourceUnavailableError();
  const managed = rows.filter((row) => row.retentionAcceptedAt != null);
  if (!managed.length) return undefined;
  return {
    sourceFileIds: managed.map((row) => row.file_id).sort(),
    sourceExpiresAt: new Date(
      Math.min(...managed.map((row) => new Date(row.expiredAt!).getTime())),
    ),
  };
}

/** Real writes to the same File rows as revoke, in the caller's Message transaction. */
export async function touchFileSources(
  mongoose: typeof import('mongoose'),
  owner: FileOwnerScope,
  ids: readonly string[],
  session: ClientSession,
): Promise<SourceRetentionContext | undefined> {
  const context = await resolveFileSources(mongoose, owner, ids, session);
  if (!context) return undefined;
  const File = mongoose.models.File as Model<IMongoFile>;
  const result = await File.updateMany(
    {
      $and: [
        fileSourceScope(owner),
        { file_id: { $in: context.sourceFileIds }, retentionAcceptedAt: { $ne: null } },
        liveFileFilter(),
      ],
    },
    { $inc: { retentionRevision: 1 } },
    { session, timestamps: false },
  );
  if (result.matchedCount !== context.sourceFileIds.length) throw new FileSourceUnavailableError();
  return context;
}

export function createFileRetentionMethods(
  mongoose: typeof import('mongoose'),
  options: { securityPolicySha256?: string } = {},
): {
  reserveFileSourceCopies(
    owner: FileOwnerScope,
    input: { reservationId: string; sourceFileIds: readonly string[]; bytes: number },
  ): Promise<FileSourceCopyReservation>;
  releaseFileSourceCopies(owner: FileOwnerScope, receipt: FileSourceCopyReservation): Promise<void>;
  captureManagedUploadOrigin(
    owner: FileOwnerScope,
    intent: UploadDerivedIntent,
    now: number,
    session: ClientSession,
  ): Promise<UploadDerivedOrigin>;
  acceptManagedUpload(input: ManagedUploadAcceptance, session: ClientSession): Promise<void>;
  claimManagedUploadProcessing(
    owner: FileOwnerScope,
    operationId: string,
    generation: number,
    now: number,
    session: ClientSession,
  ): Promise<void>;
  assertManagedUploadProcessing(
    owner: FileOwnerScope,
    operationId: string,
    generation: number,
    now: number,
    session: ClientSession,
  ): Promise<void>;
  publishManagedUpload(
    owner: FileOwnerScope,
    operationId: string,
    generation: number,
    result: ManagedDocumentResult,
    now: number,
    session: ClientSession,
  ): Promise<void>;
  revokeManagedUpload(
    owner: FileOwnerScope,
    operationId: string,
    now: number,
    session: ClientSession,
  ): Promise<{ revokedFileIds: string[] }>;
  getManagedUploadAvailability(
    owner: FileOwnerScope,
    operationIds: readonly string[],
    now: number,
  ): Promise<{ fileId: string; ready: boolean }[]>;
  touchManagedUploadForRetry(
    owner: FileOwnerScope,
    operationId: string,
    now: number,
    session: ClientSession,
  ): Promise<void>;
  getFileSourceDeletionCandidates(
    owner: FileOwnerScope,
    fileIds: readonly string[],
  ): Promise<IMongoFile[]>;
  revokeFileSources(
    owner: FileOwnerScope,
    fileIds: readonly string[],
  ): Promise<{ revokedFileIds: string[] }>;
  prepareFileSourceDeletion(
    owner: FileOwnerScope,
    fileIds: readonly string[],
  ): Promise<{ preparedFileIds: string[] }>;
  finalizeFileSourceDeletion(
    owner: FileOwnerScope,
    fileIds: readonly string[],
  ): Promise<{ completedFileIds: string[] }>;
} {
  /** Capture the existing File authority, including private drafts, in the caller's transaction. */
  async function captureManagedUploadOrigin(
    owner: FileOwnerScope,
    value: UploadDerivedIntent,
    now: number,
    session: ClientSession,
  ): Promise<UploadDerivedOrigin> {
    const intent = readUploadDerivedIntent(value);
    const scope = managedFileScope(owner);
    if (!intent || !session.inTransaction() || !Number.isSafeInteger(now) || now < 0)
      throw new FileSourceUnavailableError();
    const File = mongoose.models.File as Model<IMongoFile>;
    const live = {
      ...scope,
      retentionAcceptedAt: { $ne: null },
      status: 'ready',
      expiredAt: { $gt: new Date(now) },
      deletionRequestedAt: null,
      deletionCompletedAt: null,
      ...approvedFileFilter(options.securityPolicySha256, now),
    };
    const load = async (ids: string[]): Promise<IMongoFile[]> => {
      const rows = await File.find({ ...live, file_id: { $in: ids } })
        .select('file_id expiredAt +securityApproval +derivedOrigin')
        .session(session)
        .lean<IMongoFile[]>();
      if (rows.length !== ids.length) throw new FileSourceUnavailableError();
      return rows;
    };
    const sourceOf = (row: IMongoFile): UploadDerivedSource => {
      const subject = readUploadSecuritySubject(row.securityApproval?.subject);
      const expiresAt = new Date(row.expiredAt!).getTime();
      if (!subject || subject.operationId !== row.file_id || !Number.isSafeInteger(expiresAt))
        throw new FileSourceUnavailableError();
      return { subject, policySha256: row.securityApproval!.policySha256, expiresAt };
    };
    const lineageOf = (row: IMongoFile): UploadDerivedOrigin | undefined => {
      if (row.derivedOrigin === undefined) return undefined;
      const lineage = readUploadDerivedOrigin(row.derivedOrigin);
      if (
        !lineage ||
        lineage.ancestors.some((source) => source.subject.operationId === row.file_id)
      )
        throw new FileSourceUnavailableError();
      return lineage;
    };
    // Validated heads bound this nonrecursive union to MAX_SOURCES * (MAX_SOURCES + 1) IDs.
    const sources = new Map<string, UploadDerivedSource>();
    const add = (source: UploadDerivedSource): void => {
      const previous = sources.get(source.subject.operationId);
      if (previous && JSON.stringify(previous) !== JSON.stringify(source))
        throw new FileSourceUnavailableError();
      sources.set(source.subject.operationId, source);
    };
    for (const row of await load(intent.directSourceFileIds)) {
      add(sourceOf(row));
      for (const source of lineageOf(row)?.ancestors ?? []) add(source);
    }
    const ids = [...sources.keys()].sort();
    const rows = await load(ids);
    const lineages = new Map(rows.map((row) => [row.file_id, lineageOf(row)]));
    for (const row of rows) {
      if (JSON.stringify(sourceOf(row)) !== JSON.stringify(sources.get(row.file_id)))
        throw new FileSourceUnavailableError();
      const lineage = lineages.get(row.file_id);
      if (!lineage) continue;
      const ancestorIds = new Set(lineage.ancestors.map((source) => source.subject.operationId));
      for (const source of lineage.ancestors) {
        const id = source.subject.operationId;
        if (
          JSON.stringify(source) !== JSON.stringify(sources.get(id)) ||
          (lineages.get(id)?.ancestors ?? []).some(
            (ancestor) => !ancestorIds.has(ancestor.subject.operationId),
          )
        )
          throw new FileSourceUnavailableError();
      }
    }
    // Unavailable transitive sources take precedence over capacity, before any source touches.
    if (sources.size > UPLOAD_DERIVED_MAX_SOURCES) throw new FileSourceCapacityError();
    const assembled = {
      version: 1,
      ...intent,
      ancestors: [...sources.values()],
    };
    // Stored origins were validated above; only this newly assembled bounded value can exhaust capacity.
    if (
      new TextEncoder().encode(JSON.stringify(assembled)).length > UPLOAD_DERIVED_MAX_ORIGIN_BYTES
    )
      throw new FileSourceCapacityError();
    const origin = readUploadDerivedOrigin(assembled);
    if (!origin) throw new FileSourceUnavailableError();
    const touched = await File.updateMany(
      { ...live, file_id: { $in: ids } },
      { $inc: { retentionRevision: 1 } },
      { session, timestamps: false },
    );
    if (touched.matchedCount !== ids.length) throw new FileSourceUnavailableError();
    return origin;
  }

  function descendantFilter(scope: FilterQuery<IMongoFile>, id: string): FilterQuery<IMongoFile> {
    return {
      ...scope,
      'derivedOrigin.ancestors.subject.operationId': id,
      deletionCompletedAt: null,
    };
  }

  async function reserveFileSourceCopies(
    owner: FileOwnerScope,
    input: {
      reservationId: string;
      sourceFileIds: readonly string[];
      bytes: number;
    },
  ): Promise<FileSourceCopyReservation> {
    if (
      !/^[a-f0-9]{64}$/.test(input.reservationId) ||
      !Number.isSafeInteger(input.bytes) ||
      input.bytes <= 0 ||
      input.bytes > RESOURCE_MAX.textBytes ||
      !input.sourceFileIds.length ||
      input.sourceFileIds.length > 64
    )
      throw new FileSourceUnavailableError();
    const File = mongoose.models.File as Model<IMongoFile>;
    const session = await mongoose.startSession();
    let receipt: FileSourceCopyReservation | undefined;
    try {
      await session.withTransaction(
        async () => {
          const ids = [...new Set(input.sourceFileIds)].sort();
          const context = await touchFileSources(mongoose, owner, ids, session);
          if (context?.sourceFileIds.length !== ids.length) throw new FileSourceUnavailableError();
          const existing = await File.findOne({
            ...managedFileScope(owner),
            'retainedDerivativeReservations.reservationId': input.reservationId,
          })
            .select('file_id +retainedDerivativeReservations +retainedDerivativeBytes')
            .session(session)
            .lean<IMongoFile>();
          if (existing) {
            const prior = existing.retainedDerivativeReservations!.find(
              (item) => item.reservationId === input.reservationId,
            )!;
            if (
              prior.state !== 'held' ||
              prior.bytes !== input.bytes ||
              !ids.includes(existing.file_id)
            )
              throw new FileSourceUnavailableError();
            if (
              !Number.isSafeInteger(existing.retainedDerivativeBytes) ||
              existing.retainedDerivativeBytes! < prior.bytes + COPY_RECEIPT_BYTES
            )
              unreconciledDocumentStorage();
            receipt = { fileId: existing.file_id, ...prior };
            return;
          }
          const file = await File.findOne({ ...managedFileScope(owner), file_id: ids[0] })
            .select('file_id +retainedDerivativeReservations +retainedDerivativeBytes')
            .session(session)
            .lean<IMongoFile>();
          if (
            !file ||
            !Number.isSafeInteger(file.retainedDerivativeBytes) ||
            file.retainedDerivativeBytes! < 0
          )
            unreconciledDocumentStorage();
          if ((file.retainedDerivativeReservations?.length ?? 0) >= MAX_COPY_RECEIPTS) {
            throw Object.assign(
              new Error(
                'Document copy capacity is full. Use another document or retry after cleanup.',
              ),
              { code: 'document_capacity_exceeded' },
            );
          }
          const stored = {
            reservationId: input.reservationId,
            bytes: input.bytes,
            state: 'held' as const,
          };
          const charged = input.bytes + COPY_RECEIPT_BYTES;
          await adjustRetainedTextBytes(mongoose, charged, session);
          await File.updateOne(
            { ...managedFileScope(owner), _id: file._id },
            {
              $inc: { retainedDerivativeBytes: charged, retentionRevision: 1 },
              $push: { retainedDerivativeReservations: stored },
            },
            { session, timestamps: false },
          );
          receipt = { fileId: file.file_id, ...stored };
        },
        { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
      );
      return receipt!;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Trusted stream owner calls only after exact epoch stop and durable purge; never browser input.
   * Its persisted pre-reserve intent may stand in for a lost receipt. Missing reservations are
   * fenced with a charged tombstone; callers retain their intent on every failed/unknown outcome.
   */
  async function releaseFileSourceCopies(
    owner: FileOwnerScope,
    receipt: FileSourceCopyReservation,
  ): Promise<void> {
    if (!receipt.fileId || !/^[a-f0-9]{64}$/.test(receipt.reservationId))
      throw new FileSourceUnavailableError();
    const File = mongoose.models.File as Model<IMongoFile>;
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(
        async () => {
          const file = await File.findOne({ ...managedFileScope(owner), file_id: receipt.fileId })
            .select(
              'file_id retentionAcceptedAt deletionCompletedAt +retainedDerivativeReservations +retainedDerivativeBytes',
            )
            .session(session)
            .lean<IMongoFile>();
          if (!file) throw new FileSourceUnavailableError();
          if (file.deletionCompletedAt && file.retainedDerivativeBytes === 0) return;
          const stored = file.retainedDerivativeReservations?.find(
            (item) => item.reservationId === receipt.reservationId,
          );
          if (!stored) {
            if (!file.retentionAcceptedAt) throw new FileSourceUnavailableError();
            if (
              !Number.isSafeInteger(file.retainedDerivativeBytes) ||
              file.retainedDerivativeBytes! < 0
            )
              unreconciledDocumentStorage();
            if ((file.retainedDerivativeReservations?.length ?? 0) >= MAX_COPY_RECEIPTS) {
              throw Object.assign(
                new Error(
                  'Document copy capacity is full. Use another document or retry after cleanup.',
                ),
                { code: 'document_capacity_exceeded' },
              );
            }
            await adjustRetainedTextBytes(mongoose, COPY_RECEIPT_BYTES, session);
            await File.updateOne(
              { ...managedFileScope(owner), _id: file._id },
              {
                $inc: { retainedDerivativeBytes: COPY_RECEIPT_BYTES, retentionRevision: 1 },
                $push: {
                  retainedDerivativeReservations: {
                    reservationId: receipt.reservationId,
                    bytes: 0,
                    state: 'released',
                  },
                },
              },
              { session, timestamps: false },
            );
            return;
          }
          if (stored.state === 'released') return;
          if (
            !Number.isSafeInteger(stored.bytes) ||
            stored.bytes <= 0 ||
            !Number.isSafeInteger(file.retainedDerivativeBytes) ||
            file.retainedDerivativeBytes! < stored.bytes + COPY_RECEIPT_BYTES
          )
            unreconciledDocumentStorage();
          await adjustRetainedTextBytes(mongoose, -stored.bytes, session);
          await File.updateOne(
            { ...managedFileScope(owner), _id: file._id },
            {
              $inc: { retainedDerivativeBytes: -stored.bytes, retentionRevision: 1 },
              $set: { 'retainedDerivativeReservations.$[receipt].state': 'released' },
            },
            {
              session,
              timestamps: false,
              arrayFilters: [{ 'receipt.reservationId': receipt.reservationId }],
            },
          );
        },
        { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
      );
    } finally {
      await session.endSession();
    }
  }
  async function acceptManagedUpload(
    input: ManagedUploadAcceptance,
    session: ClientSession,
  ): Promise<void> {
    const File = mongoose.models.File as Model<IMongoFile>;
    const owner = fileSourceScope(input.principal);
    const securityApproval = captureManagedFileApproval(input, options.securityPolicySha256);
    const origin =
      input.derivedOrigin === undefined ? undefined : readUploadDerivedOrigin(input.derivedOrigin);
    const accepted = { ...input, receipt: { ...input.receipt }, principal: { ...input.principal } };
    if (
      !session.inTransaction() ||
      !isUploadPrincipal(input.principal) ||
      (input.derivedOrigin !== undefined && !origin) ||
      input.expiresAt !== uploadDerivedExpiresAt(input.acceptedAt, origin ?? undefined) ||
      input.receipt.outcome !== 'durable' ||
      !securityApproval
    )
      throw new FileSourceUnavailableError();
    if (origin) {
      if (origin.ancestors.some((source) => source.subject.operationId === accepted.operationId))
        throw new FileSourceUnavailableError();
      const actual = await captureManagedUploadOrigin(
        accepted.principal,
        { binding: origin.binding, directSourceFileIds: origin.directSourceFileIds },
        accepted.acceptedAt,
        session,
      );
      if (JSON.stringify(actual) !== JSON.stringify(origin)) throw new FileSourceUnavailableError();
      for (const source of origin.ancestors) {
        const count = await File.countDocuments(
          descendantFilter(managedFileScope(accepted.principal), source.subject.operationId),
        )
          .limit(UPLOAD_DERIVED_MAX_DESCENDANTS + 1)
          .session(session);
        if (count >= UPLOAD_DERIVED_MAX_DESCENDANTS) throw new FileSourceCapacityError();
      }
    }
    await File.create(
      [
        {
          ...owner,
          file_id: accepted.operationId,
          uploadOperationId: accepted.operationId,
          securityApproval,
          ...(origin ? { derivedOrigin: origin } : {}),
          filename: accepted.filename,
          type: accepted.mediaType,
          bytes: accepted.receipt.bytes,
          filepath: accepted.receipt.filepath,
          source: accepted.receipt.source,
          storageKey: accepted.receipt.storageKey,
          object: 'file',
          context: 'message_attachment',
          status: 'pending',
          retentionAcceptedAt: new Date(accepted.acceptedAt),
          expiredAt: new Date(accepted.expiresAt),
          retentionRevision: 0,
          llmDeliveryPath: 'text',
        },
      ],
      { session },
    );
  }
  function managedFilter(owner: FileOwnerScope, operationId: string, now: number) {
    return {
      ...managedFileScope(owner),
      file_id: operationId,
      uploadOperationId: operationId,
      retentionAcceptedAt: { $ne: null },
      expiredAt: { $gt: new Date(now) },
      deletionRequestedAt: null,
      deletionCompletedAt: null,
      ...approvedFileFilter(options.securityPolicySha256, now),
    };
  }
  async function claimManagedUploadProcessing(
    owner: FileOwnerScope,
    operationId: string,
    generation: number,
    now: number,
    session: ClientSession,
  ): Promise<void> {
    const File = mongoose.models.File as Model<IMongoFile>;
    const result = await File.updateOne(
      managedFilter(owner, operationId, now),
      {
        $set: { previewRevision: String(generation), status: 'pending' },
        $inc: { retentionRevision: 1 },
      },
      { session, timestamps: false },
    );
    if (result.matchedCount !== 1) throw new FileSourceUnavailableError();
  }
  async function publishManagedUpload(
    owner: FileOwnerScope,
    operationId: string,
    generation: number,
    input: ManagedDocumentResult,
    now: number,
    session: ClientSession,
  ): Promise<void> {
    const document = readManagedDocumentResult(input);
    if (
      !session.inTransaction() ||
      !document ||
      Buffer.byteLength(document.text, 'utf8') +
        Buffer.byteLength(JSON.stringify(document.structure), 'utf8') >
        UPLOAD_MAX_TEXT_BYTES
    ) {
      throw new FileSourceUnavailableError();
    }
    const File = mongoose.models.File as Model<IMongoFile>;
    const result = await File.updateOne(
      {
        ...managedFilter(owner, operationId, now),
        previewRevision: String(generation),
        'securityApproval.subject.sha256': document.structure.source.sha256,
        'securityApproval.subject.bytes': document.structure.source.bytes,
        'securityApproval.subject.mediaType': document.structure.source.mediaType,
        bytes: document.structure.source.bytes,
        type: document.structure.source.mediaType,
      },
      {
        $set: {
          text: document.text,
          documentStructure: document.structure,
          textFormat: 'text',
          status: 'ready',
          embedded: true,
        },
        $inc: { retentionRevision: 1 },
      },
      { session, timestamps: false },
    );
    if (result.matchedCount !== 1) throw new FileSourceUnavailableError();
  }
  async function assertManagedUploadProcessing(
    owner: FileOwnerScope,
    operationId: string,
    generation: number,
    now: number,
    session: ClientSession,
  ): Promise<void> {
    if (
      !session.inTransaction() ||
      !Number.isSafeInteger(generation) ||
      generation < 1 ||
      !Number.isSafeInteger(now) ||
      now < 0
    )
      throw new FileSourceUnavailableError();
    const File = mongoose.models.File as Model<IMongoFile>;
    const result = await File.updateOne(
      { ...managedFilter(owner, operationId, now), previewRevision: String(generation) },
      { $inc: { retentionRevision: 1 } },
      { session, timestamps: false },
    );
    if (result.matchedCount !== 1) throw new FileSourceUnavailableError();
  }

  /** The ancestor write serializes every admission with its bounded reverse-lineage revoke. */
  async function revokeSourceClosure(
    owner: FileOwnerScope,
    operationId: string,
    now: number,
    session: ClientSession,
  ): Promise<{ revokedFileIds: string[] }> {
    const scope = managedFileScope(owner);
    if (!session.inTransaction() || !Number.isSafeInteger(now) || now < 0)
      throw new FileSourceUnavailableError();
    const File = mongoose.models.File as Model<IMongoFile>;
    const root = await File.findOne({
      ...scope,
      file_id: operationId,
      retentionAcceptedAt: { $ne: null },
    })
      .select('file_id deletionRequestedAt')
      .session(session)
      .lean<IMongoFile>();
    if (!root) throw new FileSourceUnavailableError();
    await File.updateOne(
      { ...scope, _id: root._id },
      {
        $set: { deletionRequestedAt: root.deletionRequestedAt ?? new Date(now) },
        $inc: { retentionRevision: 1 },
        $unset: { deletionRetryAt: 1 },
      },
      { session, timestamps: false },
    );
    const descendants = await File.find(descendantFilter(scope, operationId))
      .select('file_id')
      .limit(UPLOAD_DERIVED_MAX_DESCENDANTS + 1)
      .session(session)
      .lean<IMongoFile[]>();
    if (descendants.length > UPLOAD_DERIVED_MAX_DESCENDANTS) throw new FileSourceUnavailableError();
    const revokedFileIds = [
      ...new Set([operationId, ...descendants.map((row) => row.file_id)]),
    ].sort();
    await File.updateMany(
      { ...scope, file_id: { $in: revokedFileIds }, deletionRequestedAt: null },
      {
        $set: { deletionRequestedAt: new Date(now) },
        $inc: { retentionRevision: 1 },
        $unset: { deletionRetryAt: 1 },
      },
      { session, timestamps: false },
    );
    return { revokedFileIds };
  }

  async function revokeManagedUpload(
    owner: FileOwnerScope,
    operationId: string,
    now: number,
    session: ClientSession,
  ): Promise<{ revokedFileIds: string[] }> {
    return revokeSourceClosure(owner, operationId, now, session);
  }
  async function getManagedUploadAvailability(
    owner: FileOwnerScope,
    operationIds: readonly string[],
    now: number,
  ): Promise<{ fileId: string; ready: boolean }[]> {
    const File = mongoose.models.File as Model<IMongoFile>;
    const rows = await File.find({
      ...managedFileScope(owner),
      uploadOperationId: { $in: operationIds },
      derivedOrigin: { $exists: false },
      expiredAt: { $gt: new Date(now) },
      deletionRequestedAt: null,
      deletionCompletedAt: null,
      ...approvedFileFilter(options.securityPolicySha256, now),
    })
      .select('file_id status')
      .lean<IMongoFile[]>();
    return rows.map((row) => ({ fileId: row.file_id, ready: row.status === 'ready' }));
  }
  async function touchManagedUploadForRetry(
    owner: FileOwnerScope,
    operationId: string,
    now: number,
    session: ClientSession,
  ): Promise<void> {
    const File = mongoose.models.File as Model<IMongoFile>;
    const result = await File.updateOne(
      managedFilter(owner, operationId, now),
      { $inc: { retentionRevision: 1 } },
      { session, timestamps: false },
    );
    if (result.matchedCount !== 1) throw new FileSourceUnavailableError();
  }
  async function loadFileSourceRecords(owner: FileOwnerScope, fileIds: readonly string[]) {
    const File = mongoose.models.File as Model<IMongoFile>;
    return File.find({
      ...managedFileScope(owner),
      file_id: { $in: [...new Set(fileIds)] },
      retentionAcceptedAt: { $ne: null },
    })
      .select('+derivedOrigin')
      .lean<IMongoFile[]>();
  }

  async function getFileSourceDeletionCandidates(
    owner: FileOwnerScope,
    fileIds: readonly string[],
  ) {
    return (await loadFileSourceRecords(owner, fileIds)).filter((row) => !row.deletionCompletedAt);
  }

  async function revokeFileSources(
    owner: FileOwnerScope,
    fileIds: readonly string[],
  ): Promise<{ revokedFileIds: string[] }> {
    const ids = [...new Set(fileIds)];
    if (!ids.length) return { revokedFileIds: [] };
    const scope = fileSourceScope(owner);
    const capturedOwner = { userId: scope.user, tenantId: scope.tenantId };
    if (ids.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 128))
      throw new FileSourceUnavailableError();
    const revoked = new Set<string>();
    for (const id of ids) {
      const session = await mongoose.startSession();
      try {
        const result = await session.withTransaction(
          () => revokeSourceClosure(capturedOwner, id, Date.now(), session),
          { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
        );
        for (const revokedId of result.revokedFileIds) revoked.add(revokedId);
      } finally {
        await session.endSession();
      }
    }
    return { revokedFileIds: [...revoked].sort() };
  }

  /** Content removal and final completion share one idempotent, child-fenced transaction. */
  async function settleFileSourceDeletion(
    owner: FileOwnerScope,
    fileIds: readonly string[],
    finalize: boolean,
  ): Promise<string[]> {
    const scope = fileSourceScope(owner);
    const capturedOwner = { userId: scope.user, tenantId: scope.tenantId };
    const File = mongoose.models.File as Model<IMongoFile>;
    const rows = await loadFileSourceRecords(capturedOwner, fileIds);
    const depth = new Map<string, number>();
    for (const row of rows) {
      const origin =
        row.derivedOrigin === undefined ? undefined : readUploadDerivedOrigin(row.derivedOrigin);
      if (row.derivedOrigin !== undefined && !origin) throw new FileSourceUnavailableError();
      depth.set(row.file_id, origin?.ancestors.length ?? 0);
    }
    rows.sort(
      (a, b) => depth.get(b.file_id)! - depth.get(a.file_id)! || a.file_id.localeCompare(b.file_id),
    );
    const completedFileIds: string[] = [];
    const keep = new Set([
      '_id',
      '__v',
      'file_id',
      'user',
      'tenantId',
      'createdAt',
      'retentionAcceptedAt',
      'expiredAt',
      'retentionRevision',
      'deletionRequestedAt',
      'deletionCompletedAt',
      'retainedDerivativeBytes',
      ...(!finalize ? ['derivedOrigin', 'uploadOperationId'] : []),
    ]);
    for (const row of rows) {
      const session = await mongoose.startSession();
      try {
        const completed = await session.withTransaction(
          async () => {
            const current = await File.findOne({ ...managedFileScope(capturedOwner), _id: row._id })
              .select(
                '+retainedDerivativeBytes +retainedDerivativeReservations +documentStructure +securityApproval +derivedOrigin',
              )
              .session(session)
              .lean<IMongoFile>();
            if (!current?.deletionRequestedAt) throw new FileSourceUnavailableError();
            if (current.deletionCompletedAt) return true;
            const pendingChild = await File.findOne(
              descendantFilter(managedFileScope(capturedOwner), current.file_id),
            )
              .select('_id')
              .session(session)
              .lean();
            if (pendingChild) return false;
            if (
              !Number.isSafeInteger(current.retainedDerivativeBytes) ||
              current.retainedDerivativeBytes! < 0
            )
              unreconciledDocumentStorage();
            await adjustRetainedTextBytes(mongoose, -current.retainedDerivativeBytes!, session);
            const unset = Object.fromEntries(
              Object.keys(current)
                .filter((key) => !keep.has(key))
                .map((key) => [key, 1]),
            );
            await File.updateOne(
              {
                ...managedFileScope(capturedOwner),
                _id: row._id,
                deletionRequestedAt: { $ne: null },
              },
              {
                $unset: unset,
                $set: {
                  retainedDerivativeBytes: 0,
                  ...(finalize ? { deletionCompletedAt: new Date() } : {}),
                },
              },
              { session, timestamps: false },
            );
            return true;
          },
          { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
        );
        if (completed) completedFileIds.push(row.file_id);
      } finally {
        await session.endSession();
      }
    }
    return completedFileIds;
  }
  /** Keep reverse lineage until the existing Upload cleanup acknowledgement is known. */
  async function prepareFileSourceDeletion(owner: FileOwnerScope, fileIds: readonly string[]) {
    return { preparedFileIds: await settleFileSourceDeletion(owner, fileIds, false) };
  }
  /** Only deletion composition calls this after the real Upload cleanup acknowledgement. */
  async function finalizeFileSourceDeletion(owner: FileOwnerScope, fileIds: readonly string[]) {
    return { completedFileIds: await settleFileSourceDeletion(owner, fileIds, true) };
  }
  return {
    captureManagedUploadOrigin,
    reserveFileSourceCopies,
    releaseFileSourceCopies,
    acceptManagedUpload,
    claimManagedUploadProcessing,
    assertManagedUploadProcessing,
    publishManagedUpload,
    revokeManagedUpload,
    getManagedUploadAvailability,
    touchManagedUploadForRetry,
    getFileSourceDeletionCandidates,
    revokeFileSources,
    prepareFileSourceDeletion,
    finalizeFileSourceDeletion,
  };
}

export type { ManagedUploadAcceptance } from '~/types/file';
