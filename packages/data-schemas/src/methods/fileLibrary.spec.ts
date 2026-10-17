/** Real native Mongo evidence for bounded organization metadata; no mocked authorization predicates. */
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { FileContext, readFileLibraryPage } from 'librechat-data-provider';
import type { FileLibraryQuery, FileLibraryUpdate } from 'librechat-data-provider';
import { createModels } from '~/models';
import { tenantStorage } from '~/config/tenantContext';
import { createFileLibraryMethods, InvalidFileLibraryInputError } from './fileLibrary';
import { createFileMethods } from './file';
// Exercise the actual project version consumer; this test does not add a production dependency.
import { toCanonicalProjectResource } from '../../../api/src/projects/resources';

const policy = 'c'.repeat(64);

describe('native File library', () => {
  const db = new mongoose.Mongoose();
  const owner = { userId: new mongoose.Types.ObjectId().toString(), tenantId: 'library-a' };
  const other = { userId: new mongoose.Types.ObjectId().toString(), tenantId: 'library-a' };
  let mongo: MongoMemoryReplSet;
  let library: ReturnType<typeof createFileLibraryMethods>;
  let files: ReturnType<typeof createFileMethods>;
  const previous = {
    enabled: process.env.CORTEX_UPLOAD_MANAGEMENT_ENABLED,
    policy: process.env.UPLOAD_SECURITY_POLICY_SHA256,
  };

  function original(id: string, scope = owner) {
    const now = Date.now() - 1000;
    return {
      user: new mongoose.Types.ObjectId(scope.userId),
      tenantId: scope.tenantId,
      file_id: id,
      filename: `Report ${id}.txt`,
      filepath: `/api/files/managed/${id}`,
      object: 'file',
      type: 'text/plain',
      bytes: 8,
      usage: 0,
      embedded: true,
      source: 's3',
      context: FileContext.message_attachment,
      status: 'ready',
      uploadOperationId: id,
      storageKey: `t/${scope.tenantId}/managed-uploads/${scope.userId}/${id}.1__original`,
      retentionAcceptedAt: new Date(now),
      expiredAt: new Date(now + 600_000),
      text: 'private content',
      createdAt: new Date(now),
      updatedAt: new Date(now),
      securityApproval: {
        version: 1,
        decision: 'approved',
        policySha256: policy,
        checkedAt: new Date(now).toISOString(),
        scannerVersion: 'explicit-fixture/v1',
        coverage: { complete: true, pages: 1, parts: 1 },
        subject: {
          ...scope,
          operationId: id,
          transferGeneration: 1,
          mediaType: 'text/plain',
          bytes: 8,
          sha256: 'd'.repeat(64),
        },
      },
    };
  }
  const raw = (id: string) => db.models.File.collection.findOne({ file_id: id });

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await db.connect(mongo.getUri('file-library'), { monitorCommands: true });
    createModels(db);
    await Promise.all(['File', 'User', 'ChatProject'].map((name) => db.models[name].init()));
    library = createFileLibraryMethods(db);
    files = createFileMethods(db);
  });
  beforeEach(async () => {
    process.env.CORTEX_UPLOAD_MANAGEMENT_ENABLED = 'true';
    process.env.UPLOAD_SECURITY_POLICY_SHA256 = policy;
    await Promise.all(
      ['File', 'User', 'ChatProject'].map((name) => db.models[name].deleteMany({})),
    );
    await db.models.User.create(
      [owner, other].map((scope, index) => ({
        _id: scope.userId,
        tenantId: scope.tenantId,
        email: `library-${index}@example.test`,
        emailVerified: true,
      })),
    );
  });
  afterAll(async () => {
    await db.disconnect();
    await mongo?.stop();
    for (const [key, value] of [
      ['CORTEX_UPLOAD_MANAGEMENT_ENABLED', previous.enabled],
      ['UPLOAD_SECURITY_POLICY_SHA256', previous.policy],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('discovers 123 originals in bounded descending pages with safe legacy defaults', async () => {
    await db.models.File.collection.insertMany(
      Array.from({ length: 123 }, (_, i) => original(`f${i}`)),
    );
    const commands: Record<string, unknown>[] = [];
    const observe = (event: { commandName: string; command: Record<string, unknown> }) => {
      if (event.commandName === 'find' && event.command.find === 'files')
        commands.push(event.command);
    };
    db.connection.getClient().on('commandStarted', observe);
    const seen: string[] = [];
    let cursor: string | undefined;
    try {
      do {
        const page = await library.getFileLibraryPage(owner, cursor ? { cursor } : {});
        expect(page.files.length).toBeLessThanOrEqual(25);
        expect(readFileLibraryPage(page)).toEqual(page);
        for (const item of page.files) {
          expect(item.library).toEqual({ tags: [], archivedAt: null, revision: 0 });
          for (const field of [
            'text',
            'storageKey',
            'securityApproval',
            'tenantId',
            'derivedOrigin',
          ])
            expect(item).not.toHaveProperty(field);
          seen.push(item.file_id);
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
    } finally {
      db.connection.getClient().off('commandStarted', observe);
    }
    expect(new Set(seen).size).toBe(123);
    expect(seen).toHaveLength(123);
    expect(commands).toHaveLength(5);
    for (const command of commands) {
      expect(command.limit).toBe(26);
      expect(command.sort).toEqual(new Map([['_id', -1]]));
      // The driver uses the remaining transaction timeout for the wire command.
      expect(command.maxTimeMS).toBeGreaterThan(0);
      expect(command.maxTimeMS).toBeLessThanOrEqual(8000);
    }
    expect(await db.models.File.countDocuments({ library: { $exists: true } })).toBe(0);
  });

  it('intersects literal search, normalized tags, exact type and owned project references', async () => {
    await db.models.File.collection.insertMany([
      original('chosen'),
      original('other'),
      original('foreign', other),
    ]);
    await library.updateFileLibrary(owner, 'chosen', {
      expectedRevision: 0,
      tags: ['  Finanz  ', 'finanz'],
    });
    const project = await db.models.ChatProject.create({
      user: owner.userId,
      tenantId: owner.tenantId,
      name: 'Owned project',
      file_ids: ['chosen', 'foreign'],
    });
    const query = {
      projectId: project._id.toString(),
      search: 'report',
      tag: 'FINANZ',
      type: 'text/plain',
    };
    expect(
      (await library.getFileLibraryPage(owner, query)).files.map((row) => row.file_id),
    ).toEqual(['chosen']);
    expect((await library.getFileLibraryPage(other, query)).files).toEqual([]);
    expect((await library.getFileLibraryPage(owner, { search: '.*' })).files).toEqual([]);
    expect((await library.getFileLibraryPage(owner, { type: 'application/pdf' })).files).toEqual(
      [],
    );
    await db.models.ChatProject.collection.updateOne(
      { _id: project._id },
      { $set: { tenantId: 'foreign' } },
    );
    expect((await library.getFileLibraryPage(owner, query)).files).toEqual([]);
  });

  it('serializes concurrent revision-zero edits without stale overwrite', async () => {
    await db.models.File.collection.insertOne(original('cas'));
    const results = await Promise.all(
      ['one', 'two'].map((tag) =>
        library.updateFileLibrary(owner, 'cas', { expectedRevision: 0, tags: [tag] }),
      ),
    );
    expect(results.map((result) => result.kind).sort()).toEqual(['conflict', 'updated']);
    const saved = (await raw('cas'))?.library;
    expect(saved.revision).toBe(1);
    expect(
      await library.updateFileLibrary(owner, 'cas', { expectedRevision: 0, tags: ['stale'] }),
    ).toEqual({ kind: 'conflict' });
    expect((await raw('cas'))?.library).toEqual(saved);
  });

  it('archives reversibly without changing bytes, expiry, timestamps or existing project references', async () => {
    await db.models.File.collection.insertOne(original('archive'));
    const project = await db.models.ChatProject.create({
      user: owner.userId,
      tenantId: owner.tenantId,
      name: 'Reference',
      file_ids: ['archive'],
    });
    const before = await raw('archive');
    const [beforeProjectFile] = await files.getProjectFiles({
      ...owner,
      fileIds: ['archive'],
      includeContent: true,
    });
    const version = toCanonicalProjectResource(beforeProjectFile).version;
    expect(
      (
        await library.updateFileLibrary(owner, 'archive', {
          expectedRevision: 0,
          archived: true,
          tags: ['Organized'],
        })
      ).kind,
    ).toBe('updated');
    expect((await library.getFileLibraryPage(owner, {})).files).toHaveLength(0);
    expect((await library.getFileLibraryPage(owner, { archive: 'archived' })).files).toHaveLength(
      1,
    );
    expect((await files.getAvailableProjectFiles(owner)).files).toHaveLength(0);
    expect(
      await files.findFileById('archive', { user: owner.userId, tenantId: owner.tenantId }),
    ).not.toBeNull();
    expect(
      await files.getProjectFiles({ ...owner, fileIds: ['archive'], includeContent: true }),
    ).toHaveLength(1);
    expect((await db.models.ChatProject.findById(project._id))?.file_ids).toEqual(['archive']);
    const after = await raw('archive');
    delete after!.library;
    expect(after).toEqual(before);
    const [archivedProjectFile] = await files.getProjectFiles({
      ...owner,
      fileIds: ['archive'],
      includeContent: true,
    });
    expect(toCanonicalProjectResource(archivedProjectFile).version).toBe(version);
    expect(
      (await library.updateFileLibrary(owner, 'archive', { expectedRevision: 1, archived: false }))
        .kind,
    ).toBe('updated');
    expect((await files.getAvailableProjectFiles(owner)).files).toHaveLength(1);
    const [afterProjectFile] = await files.getProjectFiles({
      ...owner,
      fileIds: ['archive'],
      includeContent: true,
    });
    expect(toCanonicalProjectResource(afterProjectFile).version).toBe(version);
  });

  it.each(['foreign-owner', 'foreign-tenant', 'ambient-tenant', 'disabled', 'deleting', 'absent'])(
    'returns no metadata and rejects updates for %s principals',
    async (kind) => {
      await db.models.File.collection.insertOne(original('private'));
      let caller = owner;
      if (kind === 'foreign-owner') caller = other;
      if (kind === 'foreign-tenant') caller = { ...owner, tenantId: 'foreign' };
      if (kind === 'disabled')
        await db.models.User.updateOne({ _id: owner.userId }, { $set: { authDisabled: true } });
      if (kind === 'deleting')
        await db.models.User.updateOne(
          { _id: owner.userId },
          { $set: { agentTriggerDeletionStartedAt: new Date() } },
        );
      if (kind === 'absent') await db.models.User.deleteOne({ _id: owner.userId });
      const check = async () => {
        expect(await library.getFileLibraryPage(caller, {})).toEqual({
          files: [],
          nextCursor: null,
        });
        expect(
          await library.updateFileLibrary(caller, 'private', {
            expectedRevision: 0,
            tags: ['denied'],
          }),
        ).toEqual({ kind: 'unavailable' });
      };
      if (kind === 'ambient-tenant') await tenantStorage.run({ tenantId: 'foreign' }, check);
      else await check();
      expect((await raw('private'))?.library).toBeUndefined();
    },
  );

  it.each(['expired', 'revoked', 'deleted', 'derived', 'unapproved'])(
    'excludes %s files from reads and metadata changes',
    async (kind) => {
      const row: Record<string, unknown> = original('unavailable');
      if (kind === 'expired') row.expiredAt = new Date(Date.now() - 1000);
      if (kind === 'revoked') row.deletionRequestedAt = new Date();
      if (kind === 'deleted') row.deletionCompletedAt = new Date();
      if (kind === 'derived') row.derivedOrigin = {};
      if (kind === 'unapproved') delete row.securityApproval;
      await db.models.File.collection.insertOne(row);
      expect((await library.getFileLibraryPage(owner, { archive: 'all' })).files).toEqual([]);
      expect(
        await library.updateFileLibrary(owner, 'unavailable', {
          expectedRevision: 0,
          archived: true,
        }),
      ).toEqual({ kind: 'unavailable' });
    },
  );

  it('rejects invalid inputs before touching Mongo or requesting unbounded results', async () => {
    const start = jest.spyOn(db, 'startSession');
    const find = jest.spyOn(db.models.File, 'find');
    for (const query of [
      { limit: 0 },
      { limit: 51 },
      { cursor: 'bad' },
      { user: owner.userId },
      { search: { $ne: '' } },
    ])
      await expect(
        library.getFileLibraryPage(owner, query as FileLibraryQuery),
      ).rejects.toBeInstanceOf(InvalidFileLibraryInputError);
    for (const update of [
      { expectedRevision: 0 },
      { expectedRevision: -1, tags: [] },
      { expectedRevision: 0, expiredAt: '2099-01-01' },
    ])
      await expect(
        library.updateFileLibrary(owner, 'id', update as FileLibraryUpdate),
      ).rejects.toBeInstanceOf(InvalidFileLibraryInputError);
    expect(start).not.toHaveBeenCalled();
    expect(find).not.toHaveBeenCalled();
  });

  it('keeps metadata private and prevents generic CRUD from bypassing its CAS owner', async () => {
    process.env.CORTEX_UPLOAD_MANAGEMENT_ENABLED = 'false';
    await tenantStorage.run({ tenantId: owner.tenantId }, () =>
      files.createFile(
        {
          ...original('legacy'),
          library: { tags: ['injected'], archivedAt: null, revision: 20 },
        } as never,
        true,
      ),
    );
    expect((await raw('legacy'))?.library).toBeUndefined();
    expect(
      (await library.updateFileLibrary(owner, 'legacy', { expectedRevision: 0, tags: ['owned'] }))
        .kind,
    ).toBe('updated');
    await files.updateFile({
      file_id: 'legacy',
      library: { tags: ['bypass'], archivedAt: null, revision: 99 },
    } as never);
    expect((await raw('legacy'))?.library.tags).toEqual(['owned']);
    const read = await files.findFileById('legacy');
    expect(read).not.toHaveProperty('library');
    const selected = await db.models.File.findOne({ file_id: 'legacy' }).select('+library');
    expect(selected.toJSON()).not.toHaveProperty('library');
    expect(selected.toObject()).not.toHaveProperty('library');
  });
});
