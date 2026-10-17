/** Durable private metadata; File and Upload remain the sole content/security lifecycle owners. */
import { randomUUID } from 'node:crypto';
import { readUploadDerivedIntent } from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';
import type {
  DocumentWorkspace,
  DocumentWorkspaceVersion,
  DocumentWorkspaceFormat,
  DocumentWorkspaceErrorCode,
  UploadDerivedIntent,
} from 'librechat-data-provider';
import type { FileOwnerScope } from '~/types/file';
import type { CapturedMessageArtifactSource, MessageArtifactSourceInput } from '~/types/message';
import type {
  DocumentWorkspaceRecord,
  DocumentWorkspaceRevisionRecord,
} from '~/types/documentWorkspace';
import {
  createDocumentWorkspaceModel,
  createDocumentWorkspaceRevisionModel,
} from '~/models/documentWorkspace';
import { createFileWorkspaceMethods } from './fileWorkspace';
import type { WorkspaceFileSource } from './fileWorkspace';
import { createMessageArtifactSourceMethods } from './messageArtifactSource';
import {
  touchActiveUserPrincipal,
  touchDeletingUserPrincipal,
  UserPrincipalUnavailableError,
} from './userPrincipal';
import {
  createFileRetentionMethods,
  fileSourceScope,
  FileSourceUnavailableError,
} from './fileRetention';

export class DocumentWorkspaceError extends Error {
  constructor(public readonly code: DocumentWorkspaceErrorCode) {
    super(code);
    this.name = 'DocumentWorkspaceError';
  }
}

function fail(code: DocumentWorkspaceErrorCode): never {
  throw new DocumentWorkspaceError(code);
}
const validId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,128}$/.test(value);

export function createDocumentWorkspaceMethods(
  mongoose: typeof import('mongoose'),
  options: { securityPolicySha256?: string; now?: () => number; maxWorkspaces?: number } = {},
): DocumentWorkspaceMethods {
  const Workspace = createDocumentWorkspaceModel(mongoose);
  const Version = createDocumentWorkspaceRevisionModel(mongoose);
  const files = createFileWorkspaceMethods(mongoose, options);
  const sources = createFileRetentionMethods(mongoose, options);
  const messages = createMessageArtifactSourceMethods(mongoose);
  const now = options.now ?? Date.now;
  const maxWorkspaces = options.maxWorkspaces ?? 100;
  if (!Number.isSafeInteger(maxWorkspaces) || maxWorkspaces < 1 || maxWorkspaces > 1000)
    throw new Error('invalid_workspace_limit');

  function scope(owner: FileOwnerScope) {
    const captured = fileSourceScope(owner);
    if (typeof captured.user !== 'string' || !/^[a-fA-F0-9]{24}$/.test(captured.user))
      fail('not_found');
    return { user: captured.user, tenantId: captured.tenantId };
  }
  function identity(owner: FileOwnerScope, id: string, revision?: number) {
    if (
      !validId(id) ||
      (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 0))
    )
      fail('invalid_request');
    return { ...scope(owner), workspaceId: id };
  }
  function principal(filter: { user: string; tenantId: string | null }): FileOwnerScope {
    return { userId: filter.user, tenantId: filter.tenantId };
  }
  const binding = (id: string, revision: number) => ({
    purpose: 'workspace-draft' as const,
    sourceId: id,
    sourceRevision: revision,
  });
  function intent(row: DocumentWorkspaceRecord): UploadDerivedIntent {
    return {
      binding: binding(row.workspaceId, row.revision),
      directSourceFileIds: row.headFileId ? [row.headFileId] : [...row.initialSourceFileIds],
    };
  }
  async function transaction<T>(
    owner: FileOwnerScope,
    operation: (session: ClientSession) => Promise<T>,
    deletingAt?: Date,
  ): Promise<T> {
    const user = scope(owner);
    const session = await mongoose.startSession();
    try {
      return await session.withTransaction(
        async () => {
          if (deletingAt)
            await touchDeletingUserPrincipal(
              mongoose,
              { userId: user.user, tenantId: user.tenantId },
              deletingAt,
              session,
            );
          else
            await touchActiveUserPrincipal(
              mongoose,
              { userId: user.user, tenantId: user.tenantId },
              session,
            );
          return operation(session);
        },
        {
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority', wtimeout: 2000 },
          maxCommitTimeMS: 2000,
          timeoutMS: 8000,
        },
      );
    } catch (error) {
      if (error instanceof FileSourceUnavailableError) fail('source_unavailable');
      if (error instanceof UserPrincipalUnavailableError) fail('not_found');
      throw error;
    } finally {
      await session.endSession();
    }
  }
  function project(row: DocumentWorkspaceRecord, file?: WorkspaceFileSource): DocumentWorkspace {
    return {
      workspaceId: row.workspaceId,
      title: row.title,
      format: row.format,
      revision: row.revision,
      headFileId: row.headFileId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      expiresAt: file?.expiredAt.toISOString() ?? null,
    };
  }
  async function load(filter: ReturnType<typeof identity>, session: ClientSession) {
    const row = await Workspace.findOne(filter)
      .select('+initialSourceFileIds +origin')
      .session(session)
      .lean<DocumentWorkspaceRecord>();
    if (!row) fail('not_found');
    return row;
  }
  async function touchVersion(
    owner: FileOwnerScope,
    row: DocumentWorkspaceRevisionRecord,
    session: ClientSession,
  ) {
    const parsed = readUploadDerivedIntent({ binding: row.binding, directSourceFileIds: [] });
    if (
      !parsed ||
      parsed.binding.purpose !== 'workspace-draft' ||
      parsed.binding.sourceId !== row.workspaceId ||
      parsed.binding.sourceRevision !== row.revision - 1
    )
      fail('source_unavailable');
    return files.touchWorkspaceFile(
      owner,
      { fileId: row.fileId, binding: row.binding },
      now(),
      session,
    );
  }
  async function touchHead(row: DocumentWorkspaceRecord, session: ClientSession) {
    const owner = principal(row);
    if (row.revision === 0) {
      if (row.headFileId !== null) fail('source_unavailable');
      await sources.captureManagedUploadOrigin(owner, intent(row), now(), session);
      return undefined;
    }
    const version = await Version.findOne({
      ...identity(owner, row.workspaceId),
      revision: row.revision,
    })
      .session(session)
      .lean<DocumentWorkspaceRevisionRecord>();
    if (!version || version.fileId !== row.headFileId) fail('source_unavailable');
    return touchVersion(owner, version, session);
  }
  async function create(
    owner: FileOwnerScope,
    format: DocumentWorkspaceFormat,
    artifact?: MessageArtifactSourceInput,
  ) {
    const captured = scope(owner);
    if (format !== 'text' && format !== 'markdown') fail('invalid_request');
    const workspaceId = randomUUID();
    // Only the native capture port reads artifact content; it is never put into metadata.
    return transaction(owner, async (session) => {
      if ((await Workspace.countDocuments(captured).session(session)) >= maxWorkspaces)
        fail('quota_exceeded');
      const source = artifact
        ? await messages.captureMessageArtifactSource(principal(captured), artifact, session)
        : undefined;
      if (source && Buffer.byteLength(source.artifact.content, 'utf8') > 65_536)
        fail('invalid_request');
      const at = new Date(now());
      const row: DocumentWorkspaceRecord = {
        ...captured,
        workspaceId,
        title: 'Neuer Entwurf',
        format,
        revision: 0,
        headFileId: null,
        initialSourceFileIds: source?.sourceFileIds ?? [],
        ...(source ? { origin: source.anchor } : {}),
        accessRevision: 0,
        createdAt: at,
        updatedAt: at,
      };
      await sources.captureManagedUploadOrigin(principal(captured), intent(row), now(), session);
      await Workspace.create([row], { session });
      return { workspace: project(row), ...(source ? { capturedArtifact: source.artifact } : {}) };
    });
  }
  async function getDocumentWorkspace(owner: FileOwnerScope, workspaceId: string) {
    const filter = identity(owner, workspaceId);
    return transaction(owner, async (session) => {
      const row = await load(filter, session);
      return project(row, await touchHead(row, session));
    });
  }
  return {
    /** Called only after the native account owner confirms complete File cleanup. */
    async deleteAccountDocumentWorkspaces(owner: FileOwnerScope, startedAt: Date): Promise<void> {
      if (!(startedAt instanceof Date) || !Number.isFinite(startedAt.getTime()))
        fail('invalid_request');
      const fence = new Date(startedAt.getTime());
      const filter = scope(owner);
      await transaction(
        owner,
        async (session) => {
          await Version.deleteMany(filter, { session });
          await Workspace.deleteMany(filter, { session });
        },
        fence,
      );
    },
    async createDocumentWorkspace(
      owner: FileOwnerScope,
      format: DocumentWorkspaceFormat = 'markdown',
    ) {
      return (await create(owner, format)).workspace;
    },
    /** Internal import result is transient; its bytes must pass Derived intake before first commit. */
    async createDocumentWorkspaceFromArtifact(
      owner: FileOwnerScope,
      input: MessageArtifactSourceInput,
    ) {
      const captured = {
        conversationId: input.conversationId,
        messageId: input.messageId,
        expectedVersion: input.expectedVersion,
        artifactIndex: input.artifactIndex,
      };
      return create(owner, 'markdown', captured);
    },
    getDocumentWorkspace,
    async listDocumentWorkspaces(owner: FileOwnerScope, before?: string) {
      const filter = scope(owner);
      await transaction(owner, async () => undefined);
      if (before !== undefined && !validId(before)) fail('invalid_request');
      const rows = await Workspace.find({
        ...filter,
        ...(before ? { workspaceId: { $lt: before } } : {}),
      })
        .sort({ workspaceId: -1 })
        .limit(21)
        .select('workspaceId')
        .lean();
      const workspaces: DocumentWorkspace[] = [];
      for (const row of rows.slice(0, 20)) {
        try {
          workspaces.push(await getDocumentWorkspace(principal(filter), row.workspaceId));
        } catch (error) {
          if (
            !(error instanceof DocumentWorkspaceError) ||
            !['not_found', 'source_unavailable'].includes(error.code)
          )
            throw error;
        }
      }
      await transaction(owner, async () => undefined);
      return { workspaces, nextCursor: rows.length > 20 ? rows[19].workspaceId : null };
    },
    async getDocumentWorkspaceSaveIntent(
      owner: FileOwnerScope,
      workspaceId: string,
      expectedRevision: number,
    ): Promise<UploadDerivedIntent> {
      const filter = identity(owner, workspaceId, expectedRevision);
      return transaction(owner, async (session) => {
        const row = await load(filter, session);
        if (row.revision !== expectedRevision) fail('revision_conflict');
        await touchHead(row, session);
        const changed = await Workspace.updateOne(
          { ...filter, revision: expectedRevision },
          { $inc: { accessRevision: 1 } },
          { session },
        );
        if (changed.matchedCount !== 1) fail('revision_conflict');
        return intent(row);
      });
    },
    async commitDocumentWorkspaceVersion(
      owner: FileOwnerScope,
      workspaceId: string,
      expectedRevision: number,
      fileId: string,
    ): Promise<DocumentWorkspaceVersion> {
      const filter = identity(owner, workspaceId, expectedRevision);
      if (!validId(fileId) || expectedRevision >= Number.MAX_SAFE_INTEGER) fail('invalid_request');
      return transaction(owner, async (session) => {
        const row = await load(filter, session);
        const previous = await Version.findOne({ ...filter, revision: expectedRevision + 1 })
          .session(session)
          .lean<DocumentWorkspaceRevisionRecord>();
        if (previous) {
          if (previous.fileId !== fileId) fail('revision_conflict');
          const file = await touchVersion(principal(filter), previous, session);
          return {
            workspaceId,
            revision: previous.revision,
            fileId,
            createdAt: previous.createdAt.toISOString(),
            expiresAt: file.expiredAt.toISOString(),
          };
        }
        if (row.revision !== expectedRevision) fail('revision_conflict');
        const expected = intent(row);
        const file = await files.touchWorkspaceFile(
          principal(filter),
          { fileId, binding: expected.binding },
          now(),
          session,
        );
        if (
          JSON.stringify(file.derivedOrigin.directSourceFileIds) !==
          JSON.stringify([...expected.directSourceFileIds].sort())
        )
          fail('source_unavailable');
        await touchHead(row, session);
        const at = new Date(now());
        const version: DocumentWorkspaceRevisionRecord = {
          ...filter,
          revision: expectedRevision + 1,
          fileId,
          binding: expected.binding,
          createdAt: at,
        };
        await Version.create([version], { session });
        const changed = await Workspace.updateOne(
          { ...filter, revision: expectedRevision, headFileId: row.headFileId },
          {
            $set: { revision: version.revision, headFileId: fileId, updatedAt: at },
            $inc: { accessRevision: 1 },
          },
          { session },
        );
        if (changed.matchedCount !== 1) fail('revision_conflict');
        return {
          workspaceId,
          revision: version.revision,
          fileId,
          createdAt: at.toISOString(),
          expiresAt: file.expiredAt.toISOString(),
        };
      });
    },
    /** Trusted original reader receives only a stored, currently authorized immutable version. */
    async getDocumentWorkspaceVersionFile(
      owner: FileOwnerScope,
      workspaceId: string,
      revision: number,
    ) {
      const filter = identity(owner, workspaceId, revision);
      if (revision < 1) fail('invalid_request');
      return transaction(owner, async (session) => {
        await load(filter, session);
        const row = await Version.findOne({ ...filter, revision })
          .session(session)
          .lean<DocumentWorkspaceRevisionRecord>();
        if (!row) fail('not_found');
        return touchVersion(principal(filter), row, session);
      });
    },
  };
}

export interface DocumentWorkspaceMethods {
  deleteAccountDocumentWorkspaces(owner: FileOwnerScope, startedAt: Date): Promise<void>;
  createDocumentWorkspace(
    owner: FileOwnerScope,
    format?: DocumentWorkspaceFormat,
  ): Promise<DocumentWorkspace>;
  createDocumentWorkspaceFromArtifact(
    owner: FileOwnerScope,
    input: MessageArtifactSourceInput,
  ): Promise<{
    workspace: DocumentWorkspace;
    capturedArtifact?: CapturedMessageArtifactSource['artifact'];
  }>;
  getDocumentWorkspace(owner: FileOwnerScope, workspaceId: string): Promise<DocumentWorkspace>;
  listDocumentWorkspaces(
    owner: FileOwnerScope,
    before?: string,
  ): Promise<{
    workspaces: DocumentWorkspace[];
    nextCursor: string | null;
  }>;
  getDocumentWorkspaceSaveIntent(
    owner: FileOwnerScope,
    workspaceId: string,
    expectedRevision: number,
  ): Promise<UploadDerivedIntent>;
  commitDocumentWorkspaceVersion(
    owner: FileOwnerScope,
    workspaceId: string,
    expectedRevision: number,
    fileId: string,
  ): Promise<DocumentWorkspaceVersion>;
  getDocumentWorkspaceVersionFile(
    owner: FileOwnerScope,
    workspaceId: string,
    revision: number,
  ): Promise<WorkspaceFileSource>;
}
