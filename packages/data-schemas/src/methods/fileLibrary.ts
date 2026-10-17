/** Personal organization on the original File; retention and content remain with their native owners. */
import { Types } from 'mongoose';
import {
  FILE_LIBRARY_ITEM_FIELDS,
  readFileLibraryItem,
  readFileLibraryMetadata,
  readFileLibraryQuery,
  readFileLibraryUpdate,
} from 'librechat-data-provider';
import type {
  FileLibraryItem,
  FileLibraryMetadata,
  FileLibraryPage,
  FileLibraryQuery,
  FileLibraryUpdate,
  FileLibraryUpdateResult,
} from 'librechat-data-provider';
import type { ClientSession, FilterQuery, Model } from 'mongoose';
import type { FileOwnerScope, IMongoFile } from '~/types/file';
import { fileSourceScope, FileSourceUnavailableError, liveFileFilter } from './fileRetention';
import { touchActiveUserPrincipal, UserPrincipalUnavailableError } from './userPrincipal';
import { createChatProjectMethods } from './chatProject';
import { escapeRegExp } from '~/utils/string';

export class InvalidFileLibraryInputError extends Error {
  readonly code = 'invalid_request';
  constructor() {
    super('Invalid file library input');
    this.name = 'InvalidFileLibraryInputError';
  }
}

export type FileLibraryMethods = {
  getFileLibraryPage(owner: FileOwnerScope, query: FileLibraryQuery): Promise<FileLibraryPage>;
  updateFileLibrary(
    owner: FileOwnerScope,
    fileId: string,
    update: FileLibraryUpdate,
  ): Promise<FileLibraryUpdateResult>;
};

function metadata(value: unknown): FileLibraryMetadata {
  if (value === undefined) return { tags: [], archivedAt: null, revision: 0 };
  const result = readFileLibraryMetadata(value);
  if (!result) throw new FileSourceUnavailableError();
  return result;
}

function project(file: IMongoFile): FileLibraryItem {
  const item: Record<string, unknown> = {};
  for (const key of FILE_LIBRARY_ITEM_FIELDS) {
    const value = file[key];
    if (value !== undefined) item[key] = value instanceof Date ? value.toISOString() : value;
  }
  item.user = file.user.toString();
  item.embedded = file.embedded ?? false;
  item.usage = file.usage ?? 0;
  item.library = metadata(file.library);
  const result = readFileLibraryItem(item);
  if (!result) throw new FileSourceUnavailableError();
  return result;
}

export function createFileLibraryMethods(mongoose: typeof import('mongoose')): FileLibraryMethods {
  const projects = createChatProjectMethods(mongoose);

  function capture(owner: FileOwnerScope) {
    const scope = fileSourceScope(owner);
    if (typeof scope.user !== 'string' || !/^[a-fA-F0-9]{24}$/.test(scope.user))
      throw new FileSourceUnavailableError();
    return scope;
  }

  async function transaction<T>(
    scope: ReturnType<typeof capture>,
    action: (session: ClientSession) => Promise<T>,
  ): Promise<T> {
    const session = await mongoose.startSession();
    try {
      return await session.withTransaction(
        async () => {
          await touchActiveUserPrincipal(
            mongoose,
            { userId: scope.user, tenantId: scope.tenantId },
            session,
          );
          return action(session);
        },
        {
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority', wtimeout: 2000 },
          maxCommitTimeMS: 2000,
          timeoutMS: 8000,
        },
      );
    } finally {
      await session.endSession();
    }
  }

  async function getFileLibraryPage(
    owner: FileOwnerScope,
    input: FileLibraryQuery,
  ): Promise<FileLibraryPage> {
    const query = readFileLibraryQuery(input);
    if (!query) throw new InvalidFileLibraryInputError();
    try {
      const scope = capture(owner);
      let projectFileIds: string[] | undefined;
      if (query.projectId) {
        const ownedProject = await projects.getChatProject(scope.user, query.projectId);
        if (!ownedProject || (ownedProject.tenantId ?? null) !== scope.tenantId)
          return { files: [], nextCursor: null };
        projectFileIds = [...(ownedProject.file_ids ?? [])];
      }
      return await transaction(scope, async (session) => {
        const filters: FilterQuery<IMongoFile>[] = [scope, liveFileFilter()];
        if (query.archive === 'active') filters.push({ 'library.archivedAt': null });
        if (query.archive === 'archived') filters.push({ 'library.archivedAt': { $ne: null } });
        if (query.cursor) filters.push({ _id: { $lt: new Types.ObjectId(query.cursor) } });
        if (query.search)
          filters.push({ filename: { $regex: escapeRegExp(query.search), $options: 'i' } });
        if (query.tag)
          filters.push({
            'library.tags': { $regex: `^${escapeRegExp(query.tag)}$`, $options: 'i' },
          });
        if (query.type) filters.push({ type: query.type });
        if (projectFileIds) filters.push({ file_id: { $in: projectFileIds } });
        const File = mongoose.models.File as Model<IMongoFile>;
        const rows = await File.find({ $and: filters })
          .select(['_id', ...FILE_LIBRARY_ITEM_FIELDS, '+library'].join(' '))
          .sort({ _id: -1 })
          .limit(query.limit + 1)
          .maxTimeMS(2000)
          .session(session)
          .lean<IMongoFile[]>();
        const more = rows.length > query.limit;
        if (more) rows.pop();
        return {
          files: rows.map(project),
          nextCursor: more ? rows[rows.length - 1]._id.toString() : null,
        };
      });
    } catch (error) {
      if (
        error instanceof FileSourceUnavailableError ||
        error instanceof UserPrincipalUnavailableError
      )
        return { files: [], nextCursor: null };
      throw error;
    }
  }

  async function updateFileLibrary(
    owner: FileOwnerScope,
    fileId: string,
    input: FileLibraryUpdate,
  ): Promise<FileLibraryUpdateResult> {
    const update = readFileLibraryUpdate(input);
    if (!update || typeof fileId !== 'string' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(fileId))
      throw new InvalidFileLibraryInputError();
    try {
      const scope = capture(owner);
      return await transaction(scope, async (session): Promise<FileLibraryUpdateResult> => {
        const File = mongoose.models.File as Model<IMongoFile>;
        const filter = { $and: [scope, { file_id: fileId }, liveFileFilter()] };
        const row = await File.findOne(filter)
          .select('_id +library')
          .maxTimeMS(2000)
          .session(session)
          .lean<IMongoFile>();
        if (!row) return { kind: 'unavailable' };
        const previous = metadata(row.library);
        if (
          previous.revision !== update.expectedRevision ||
          previous.revision === Number.MAX_SAFE_INTEGER
        )
          return { kind: 'conflict' };
        let archivedAt = previous.archivedAt;
        if (update.archived === true) archivedAt ??= new Date().toISOString();
        if (update.archived === false) archivedAt = null;
        const library: FileLibraryMetadata = {
          tags: update.tags ?? previous.tags,
          archivedAt,
          revision: previous.revision + 1,
        };
        const revisionFilter =
          row.library === undefined
            ? { library: { $exists: false } }
            : { 'library.revision': update.expectedRevision };
        const result = await File.updateOne(
          { $and: [scope, { _id: row._id, file_id: fileId }, revisionFilter, liveFileFilter()] },
          { $set: { library } },
          { session, timestamps: false, upsert: false, maxTimeMS: 2000 },
        );
        if (!result.acknowledged || result.matchedCount !== 1) return { kind: 'unavailable' };
        return { kind: 'updated', library };
      });
    } catch (error) {
      if (
        error instanceof FileSourceUnavailableError ||
        error instanceof UserPrincipalUnavailableError
      )
        return { kind: 'unavailable' };
      throw error;
    }
  }

  return { getFileLibraryPage, updateFileLibrary };
}
