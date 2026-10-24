import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  FileContext,
  MAX_CHAT_PROJECT_FILES,
  MAX_CHAT_PROJECT_INSTRUCTIONS_LENGTH,
} from 'librechat-data-provider';
import type { IChatProject, IConversation, IMongoFile } from '~/types';
import {
  createChatProjectMethods,
  updateChatProjectLastConversationForUser,
  type ChatProjectMethods,
} from './chatProject';
import { initialFileRetentionActivity } from './fileActivityTransition';
import { createHousekeepingStore } from './housekeepingStore';
import { tenantStorage } from '~/config/tenantContext';
import { createFileMethods } from './file';
import { createModels } from '~/models';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: InstanceType<typeof MongoMemoryReplSet>;
let ChatProject: mongoose.Model<IChatProject>;
let Conversation: mongoose.Model<IConversation>;
let File: mongoose.Model<IMongoFile>;
let methods: ChatProjectMethods;
let modelsToCleanup: string[] = [];

beforeAll(async () => {
  mongoServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const mongoUri = mongoServer.getUri();

  const models = createModels(mongoose);
  modelsToCleanup = Object.keys(models);
  Object.assign(mongoose.models, models);

  ChatProject = mongoose.models.ChatProject as mongoose.Model<IChatProject>;
  Conversation = mongoose.models.Conversation as mongoose.Model<IConversation>;
  File = mongoose.models.File as mongoose.Model<IMongoFile>;
  methods = createChatProjectMethods(mongoose);

  await mongoose.connect(mongoUri);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();

  for (const modelName of modelsToCleanup) {
    if (mongoose.models[modelName]) {
      delete mongoose.models[modelName];
    }
  }
});

afterEach(async () => {
  await ChatProject.deleteMany({});
  await Conversation.deleteMany({});
  await File.deleteMany({});
});

async function createConversation(user: string, conversationId: string, title: string) {
  return await Conversation.create({
    conversationId,
    title,
    user,
    endpoint: 'openAI',
  });
}

describe('ChatProject methods', () => {
  const user = 'user-1';
  const otherUser = 'user-2';

  it('creates, reads, updates, and lists private projects', async () => {
    const project = await methods.createChatProject(user, {
      name: 'Customer Alpha',
      description: 'Support work',
    });

    expect(project.name).toBe('Customer Alpha');
    expect(project.conversationCount).toBe(0);

    const readProject = await methods.getChatProject(user, project._id!.toString());
    expect(readProject?.description).toBe('Support work');

    const updatedProject = await methods.updateChatProject(user, project._id!.toString(), {
      name: 'Customer Alpha Updated',
    });
    expect(updatedProject?.name).toBe('Customer Alpha Updated');

    const list = await methods.listChatProjects(user, { sortBy: 'name', sortDirection: 'asc' });
    expect(list.projects).toHaveLength(1);
    expect(list.projects[0].name).toBe('Customer Alpha Updated');
  });

  it('filters projects by name or description search', async () => {
    await methods.createChatProject(user, {
      name: 'Customer Alpha',
      description: 'Support work',
    });
    await methods.createChatProject(user, {
      name: 'Internal Tools',
      description: 'Overflow menu test',
    });

    const byName = await methods.listChatProjects(user, { search: 'alpha' });
    expect(byName.projects.map((project) => project.name)).toEqual(['Customer Alpha']);

    const byDescription = await methods.listChatProjects(user, { search: 'overflow' });
    expect(byDescription.projects.map((project) => project.name)).toEqual(['Internal Tools']);

    const noMatch = await methods.listChatProjects(user, { search: 'zzzz' });
    expect(noMatch.projects).toHaveLength(0);
  });

  it('paginates projects deterministically when latest activity is null', async () => {
    const staleProject = await methods.createChatProject(user, { name: 'Stale' });
    await methods.createChatProject(user, { name: 'Quiet A' });
    await methods.createChatProject(user, { name: 'Quiet B' });
    const recentProject = await methods.createChatProject(user, { name: 'Recent' });

    await ChatProject.updateOne(
      { _id: staleProject._id },
      { $set: { lastConversationAt: new Date('2026-01-01T00:00:00.000Z') } },
    );
    await ChatProject.updateOne(
      { _id: recentProject._id },
      { $set: { lastConversationAt: new Date('2026-02-01T00:00:00.000Z') } },
    );

    const firstPage = await methods.listChatProjects(user, {
      sortBy: 'lastConversationAt',
      sortDirection: 'desc',
      limit: 3,
    });
    const secondPage = await methods.listChatProjects(user, {
      sortBy: 'lastConversationAt',
      sortDirection: 'desc',
      limit: 3,
      cursor: firstPage.nextCursor,
    });
    const names = [...firstPage.projects, ...secondPage.projects].map((project) => project.name);

    expect(firstPage.projects[0].name).toBe('Recent');
    expect(firstPage.projects[1].name).toBe('Stale');
    expect(firstPage.nextCursor).toBeTruthy();
    expect(secondPage.projects.every((project) => project.lastConversationAt == null)).toBe(true);
    expect(names).toEqual(expect.arrayContaining(['Recent', 'Stale', 'Quiet A', 'Quiet B']));
    expect(new Set(names).size).toBe(4);

    const invalidCursor = Buffer.from(
      JSON.stringify({ primary: 'not-a-date', id: recentProject._id!.toString() }),
    ).toString('base64');
    const invalidCursorPage = await methods.listChatProjects(user, {
      sortBy: 'lastConversationAt',
      sortDirection: 'desc',
      limit: 1,
      cursor: invalidCursor,
    });

    expect(invalidCursorPage.projects[0].name).toBe('Recent');
  });

  it('paginates chat-less projects when a page ends on the last dated project', async () => {
    const staleProject = await methods.createChatProject(user, { name: 'Stale' });
    await methods.createChatProject(user, { name: 'Quiet A' });
    await methods.createChatProject(user, { name: 'Quiet B' });
    const recentProject = await methods.createChatProject(user, { name: 'Recent' });

    await ChatProject.updateOne(
      { _id: staleProject._id },
      { $set: { lastConversationAt: new Date('2026-01-01T00:00:00.000Z') } },
    );
    await ChatProject.updateOne(
      { _id: recentProject._id },
      { $set: { lastConversationAt: new Date('2026-02-01T00:00:00.000Z') } },
    );

    // limit equals the number of dated projects, so the cursor lands on a dated
    // project; the null (chat-less) projects must still appear on the next page.
    const firstPage = await methods.listChatProjects(user, {
      sortBy: 'lastConversationAt',
      sortDirection: 'desc',
      limit: 2,
    });
    const secondPage = await methods.listChatProjects(user, {
      sortBy: 'lastConversationAt',
      sortDirection: 'desc',
      limit: 2,
      cursor: firstPage.nextCursor,
    });

    expect(firstPage.projects.map((project) => project.name)).toEqual(['Recent', 'Stale']);
    expect(firstPage.nextCursor).toBeTruthy();
    expect(secondPage.projects.map((project) => project.name).sort()).toEqual([
      'Quiet A',
      'Quiet B',
    ]);
    expect(secondPage.projects.every((project) => project.lastConversationAt == null)).toBe(true);
  });

  it('assigns many conversations to one project and updates stats', async () => {
    const project = await methods.createChatProject(user, { name: 'Customer Alpha' });
    await createConversation(user, 'convo-1', 'First');
    await createConversation(user, 'convo-2', 'Second');

    await methods.assignConversationToProject(user, 'convo-1', project._id!.toString());
    await methods.assignConversationToProject(user, 'convo-2', project._id!.toString());

    const conversations = await Conversation.find({
      user,
      chatProjectId: project._id!.toString(),
    }).lean<IConversation[]>();
    const refreshedProject = await methods.getChatProject(user, project._id!.toString());

    expect(conversations).toHaveLength(2);
    expect(refreshedProject?.conversationCount).toBe(2);
    expect(refreshedProject?.lastConversationId).toBeDefined();
  });

  it('excludes retention-hidden conversations from project stats', async () => {
    const project = await methods.createChatProject(user, { name: 'Visible Stats' });
    const chatProjectId = project._id!.toString();
    const visibleDate = new Date('2026-01-01T00:00:00.000Z');
    const hiddenDate = new Date('2026-02-01T00:00:00.000Z');

    await Conversation.collection.insertMany([
      {
        conversationId: 'visible-convo',
        title: 'Visible',
        user,
        endpoint: 'openAI',
        chatProjectId,
        isTemporary: false,
        expiredAt: null,
        createdAt: visibleDate,
        updatedAt: visibleDate,
      },
      {
        conversationId: 'temporary-convo',
        title: 'Temporary',
        user,
        endpoint: 'openAI',
        chatProjectId,
        isTemporary: true,
        expiredAt: new Date('2027-03-01T00:00:00.000Z'),
        createdAt: hiddenDate,
        updatedAt: hiddenDate,
      },
      {
        conversationId: 'expired-convo',
        title: 'Expired',
        user,
        endpoint: 'openAI',
        chatProjectId,
        isTemporary: false,
        expiredAt: new Date('2025-12-01T00:00:00.000Z'),
        createdAt: hiddenDate,
        updatedAt: hiddenDate,
      },
    ]);

    const refreshedProject = await methods.refreshChatProjectStats(user, chatProjectId);

    expect(refreshedProject?.conversationCount).toBe(1);
    expect(refreshedProject?.lastConversationId).toBe('visible-convo');
    expect(refreshedProject?.lastConversationAt?.toISOString()).toBe(visibleDate.toISOString());
  });

  it('retries instead of overwriting a newer concurrent stats update', async () => {
    const project = await methods.createChatProject(user, { name: 'Concurrent Stats' });
    const chatProjectId = project._id!.toString();
    const initialDate = new Date('2026-01-01T00:00:00.000Z');
    const newerDate = new Date('2026-02-01T00:00:00.000Z');

    await Conversation.collection.insertOne({
      conversationId: 'initial-convo',
      title: 'Initial',
      user,
      endpoint: 'openAI',
      chatProjectId,
      createdAt: initialDate,
      updatedAt: initialDate,
    });
    await ChatProject.findByIdAndUpdate(project._id, {
      conversationCount: 1,
      lastConversationAt: initialDate,
      lastConversationId: 'initial-convo',
    });

    const findOneAndUpdate = ChatProject.findOneAndUpdate.bind(ChatProject);
    const updateSpy = jest
      .spyOn(ChatProject, 'findOneAndUpdate')
      .mockImplementationOnce((filter, update, options) => {
        const query = findOneAndUpdate(filter, update, options);
        const exec = query.exec.bind(query);
        jest.spyOn(query, 'exec').mockImplementationOnce(async () => {
          await Conversation.collection.insertOne({
            conversationId: 'newer-convo',
            title: 'Newer',
            user,
            endpoint: 'openAI',
            chatProjectId,
            createdAt: newerDate,
            updatedAt: newerDate,
          });
          await ChatProject.updateOne(
            { _id: project._id },
            {
              conversationCount: 2,
              lastConversationAt: newerDate,
              lastConversationId: 'newer-convo',
            },
          );
          return await exec();
        });
        return query;
      });

    try {
      const refreshed = await methods.refreshChatProjectStats(user, chatProjectId);

      expect(refreshed?.conversationCount).toBe(2);
      expect(refreshed?.lastConversationId).toBe('newer-convo');
      expect(refreshed?.lastConversationAt?.toISOString()).toBe(newerDate.toISOString());
      expect(updateSpy).toHaveBeenCalledTimes(2);
    } finally {
      updateSpy.mockRestore();
    }

    const persisted = await ChatProject.findById(project._id).lean<IChatProject>();
    expect(persisted?.conversationCount).toBe(2);
    expect(persisted?.lastConversationId).toBe('newer-convo');
    expect(persisted?.lastConversationAt?.toISOString()).toBe(newerDate.toISOString());
  });

  it('keeps reconciling after the first three optimistic attempts lose the race', async () => {
    const project = await methods.createChatProject(user, { name: 'Exhausted Then Succeeds' });
    const chatProjectId = project._id!.toString();
    await ChatProject.findByIdAndUpdate(project._id, {
      conversationCount: 4,
      lastConversationId: 'stale-convo',
    });

    let casAttempts = 0;
    const findOneAndUpdate = ChatProject.findOneAndUpdate.bind(ChatProject);
    const updateSpy = jest
      .spyOn(ChatProject, 'findOneAndUpdate')
      .mockImplementation((filter, update, options) => {
        const query = findOneAndUpdate(filter, update, options);
        const exec = query.exec.bind(query);
        jest.spyOn(query, 'exec').mockImplementation(async () => {
          casAttempts += 1;
          if (casAttempts <= 3) {
            await ChatProject.updateOne(
              { _id: project._id },
              {
                lastConversationAt: new Date(`2026-03-0${casAttempts}T00:00:00.000Z`),
                lastConversationId: `concurrent-${casAttempts}`,
              },
            );
          }
          return await exec();
        });
        return query;
      });

    try {
      const refreshed = await methods.refreshChatProjectStats(user, chatProjectId);
      expect(refreshed?.conversationCount).toBe(0);
      expect(refreshed?.lastConversationId).toBeNull();
      expect(casAttempts).toBeGreaterThan(3);
    } finally {
      updateSpy.mockRestore();
    }

    const persisted = await ChatProject.findById(project._id).lean<IChatProject>();
    expect(persisted?.conversationCount).toBe(0);
    expect(persisted?.lastConversationId).toBeNull();
  });

  it('throws instead of returning stale stats when every optimistic write loses', async () => {
    const project = await methods.createChatProject(user, { name: 'Never Settles' });
    const chatProjectId = project._id!.toString();
    await ChatProject.findByIdAndUpdate(project._id, {
      conversationCount: 4,
      lastConversationId: 'stale-convo',
    });

    const updateSpy = jest.spyOn(ChatProject, 'findOneAndUpdate').mockImplementation(
      () =>
        ({
          lean: async () => null,
        }) as unknown as ReturnType<typeof ChatProject.findOneAndUpdate>,
    );

    try {
      await expect(methods.refreshChatProjectStats(user, chatProjectId)).rejects.toThrow(
        /refresh chat project stats/i,
      );
    } finally {
      updateSpy.mockRestore();
    }

    const persisted = await ChatProject.findById(project._id).lean<IChatProject>();
    expect(persisted?.conversationCount).toBe(4);
    expect(persisted?.lastConversationId).toBe('stale-convo');
  });

  it('does not increment again when a refresh already counted the new conversation', async () => {
    const project = await methods.createChatProject(user, { name: 'Pending Increment' });
    const chatProjectId = project._id!.toString();
    const createdAt = new Date('2026-04-01T00:00:00.000Z');
    await Conversation.create({
      conversationId: 'new-convo',
      title: 'New',
      user,
      endpoint: 'openAI',
      chatProjectId,
      createdAt,
      updatedAt: createdAt,
    });

    const refreshed = await methods.refreshChatProjectStats(user, chatProjectId);
    expect(refreshed?.conversationCount).toBe(1);
    expect(refreshed?.lastConversationId).toBe('new-convo');

    await updateChatProjectLastConversationForUser(
      mongoose,
      user,
      chatProjectId,
      {
        conversationId: 'new-convo',
        createdAt,
        updatedAt: createdAt,
      },
      true,
    );

    const persisted = await ChatProject.findById(project._id).lean<IChatProject>();
    expect(persisted?.conversationCount).toBe(1);
    expect(persisted?.lastConversationId).toBe('new-convo');
  });

  it.each([false, true])(
    'keeps newer project activity when an older update arrives last (increment: %s)',
    async (incrementCount) => {
      const project = await methods.createChatProject(user, { name: 'Concurrent Replies' });
      const chatProjectId = project._id!.toString();
      const olderAt = new Date('2026-04-01T00:00:00.000Z');
      const newerAt = new Date('2026-04-02T00:00:00.000Z');
      await Conversation.create([
        {
          user,
          chatProjectId,
          endpoint: 'openAI',
          conversationId: 'older-reply',
          createdAt: olderAt,
          updatedAt: olderAt,
        },
        {
          user,
          chatProjectId,
          endpoint: 'openAI',
          conversationId: 'newer-reply',
          createdAt: newerAt,
          updatedAt: newerAt,
        },
      ]);
      await methods.refreshChatProjectStats(user, chatProjectId);

      await updateChatProjectLastConversationForUser(
        mongoose,
        user,
        chatProjectId,
        { conversationId: 'older-reply', createdAt: olderAt, updatedAt: olderAt },
        incrementCount,
      );

      const persisted = await methods.getChatProject(user, chatProjectId);
      expect(persisted?.lastConversationId).toBe('newer-reply');
      expect(persisted?.lastConversationAt).toEqual(newerAt);
      expect(persisted?.conversationCount).toBe(2);
    },
  );

  it('enforces one project per chat when moving conversations', async () => {
    const firstProject = await methods.createChatProject(user, { name: 'First' });
    const secondProject = await methods.createChatProject(user, { name: 'Second' });
    await createConversation(user, 'convo-1', 'First');

    await methods.assignConversationToProject(user, 'convo-1', firstProject._id!.toString());
    await methods.assignConversationToProject(user, 'convo-1', secondProject._id!.toString());

    const movedConversation = await Conversation.findOne({
      user,
      conversationId: 'convo-1',
    }).lean<IConversation>();
    const refreshedFirst = await methods.getChatProject(user, firstProject._id!.toString());
    const refreshedSecond = await methods.getChatProject(user, secondProject._id!.toString());

    expect(movedConversation?.chatProjectId).toBe(secondProject._id!.toString());
    expect(refreshedFirst?.conversationCount).toBe(0);
    expect(refreshedSecond?.conversationCount).toBe(1);
  });

  it('deleting a project unassigns chats instead of deleting them', async () => {
    const project = await methods.createChatProject(user, { name: 'Delete me' });
    await createConversation(user, 'convo-1', 'First');
    await methods.assignConversationToProject(user, 'convo-1', project._id!.toString());

    const result = await methods.deleteChatProject(user, project._id!.toString());
    const conversation = await Conversation.findOne({
      user,
      conversationId: 'convo-1',
    }).lean<IConversation>();

    expect(result.deletedCount).toBe(1);
    expect(result.modifiedCount).toBe(1);
    expect(conversation).not.toBeNull();
    expect(conversation?.chatProjectId).toBeUndefined();
  });

  it('unassigns chats before deleting and keeps the project when the unassign fails', async () => {
    const project = await methods.createChatProject(user, { name: 'Ordered' });
    await createConversation(user, 'convo-order', 'First');
    await methods.assignConversationToProject(user, 'convo-order', project._id!.toString());
    const spy = jest.spyOn(Conversation, 'updateMany').mockRejectedValueOnce(new Error('boom'));

    await expect(methods.deleteChatProject(user, project._id!.toString())).rejects.toThrow('boom');
    spy.mockRestore();

    expect(await ChatProject.countDocuments({ _id: project._id })).toBe(1);
    const conversation = await Conversation.findOne({ conversationId: 'convo-order' }).lean();
    expect(conversation?.chatProjectId).toBe(project._id!.toString());
  });

  it('isolates projects and assignments by user', async () => {
    const project = await methods.createChatProject(user, { name: 'Mine' });
    await createConversation(otherUser, 'convo-1', 'Theirs');

    const otherRead = await methods.getChatProject(otherUser, project._id!.toString());
    const assignment = await methods.assignConversationToProject(
      user,
      'convo-1',
      project._id!.toString(),
    );
    const deleteResult = await methods.deleteChatProject(otherUser, project._id!.toString());

    expect(otherRead).toBeNull();
    expect(assignment).toBeNull();
    expect(deleteResult.deletedCount).toBe(0);
  });
});

describe('persistent Project context', () => {
  const owner = new mongoose.Types.ObjectId().toString();
  const otherOwner = new mongoose.Types.ObjectId().toString();

  async function createReference(
    fileId: string,
    overrides: Omit<Partial<IMongoFile>, 'tenantId'> & { tenantId?: string | null } = {},
  ) {
    return File.create({
      user: owner,
      file_id: fileId,
      filename: `${fileId}.pdf`,
      filepath: `/uploads/${fileId}.pdf`,
      type: 'application/pdf',
      bytes: 100,
      embedded: true,
      context: FileContext.message_attachment,
      ...overrides,
    });
  }

  describe('current File eligibility', () => {
    const policy = 'a'.repeat(64);
    let previousPolicy: string | undefined;
    let previousManagedOnly: string | undefined;
    let housekeeping: ReturnType<typeof createHousekeepingStore>;

    beforeAll(async () => {
      housekeeping = createHousekeepingStore(mongoose);
      await housekeeping.initialize();
      modelsToCleanup.push(housekeeping.model.modelName);
    });
    beforeEach(() => {
      previousPolicy = process.env.UPLOAD_SECURITY_POLICY_SHA256;
      previousManagedOnly = process.env.CORTEX_UPLOAD_MANAGEMENT_ENABLED;
      process.env.UPLOAD_SECURITY_POLICY_SHA256 = policy;
      delete process.env.CORTEX_UPLOAD_MANAGEMENT_ENABLED;
    });
    afterEach(async () => {
      if (previousPolicy === undefined) delete process.env.UPLOAD_SECURITY_POLICY_SHA256;
      else process.env.UPLOAD_SECURITY_POLICY_SHA256 = previousPolicy;
      if (previousManagedOnly === undefined) delete process.env.CORTEX_UPLOAD_MANAGEMENT_ENABLED;
      else process.env.CORTEX_UPLOAD_MANAGEMENT_ENABLED = previousManagedOnly;
      await housekeeping.model.deleteMany({});
    });

    async function createManagedReference(fileId: string) {
      const tenantId = tenantStorage.getStore()?.tenantId ?? null;
      const now = Date.now();
      const acceptedAt = new Date(now - 1_000);
      const expiredAt = new Date(now + 86_400_000);
      return createReference(fileId, {
        tenantId,
        uploadOperationId: fileId,
        retentionAcceptedAt: acceptedAt,
        expiredAt,
        retentionActivity: initialFileRetentionActivity(expiredAt, acceptedAt, 'complete'),
        retentionRevision: 0,
        expiresAt: new Date(now + 3_600_000),
        temp_file_id: `temporary-${fileId}`,
        source: 's3',
        storageKey: `${tenantId ? `t/${tenantId}/` : ''}managed-uploads/${owner}/${fileId}.1__original`,
        status: 'ready',
        securityApproval: {
          version: 1,
          decision: 'approved',
          policySha256: policy,
          scannerVersion: 'fixture/1',
          checkedAt: acceptedAt.toISOString(),
          coverage: { complete: true, pages: 1, parts: 1 },
          subject: {
            tenantId,
            userId: owner,
            operationId: fileId,
            transferGeneration: 1,
            mediaType: 'application/pdf',
            bytes: 100,
            sha256: 'b'.repeat(64),
          },
        },
      });
    }

    function expiredFixtureFields(file: IMongoFile) {
      const expiredAt = new Date(file.retentionAcceptedAt!.getTime() + 1);
      return {
        expiredAt,
        retentionActivity: initialFileRetentionActivity(
          expiredAt,
          file.retentionAcceptedAt!,
          'complete',
        ),
      };
    }

    async function expectCommittedRevocation(original: IMongoFile) {
      const revoked = await File.findById(original._id)
        .select('+retentionActivity +retentionRevocationId')
        .lean<IMongoFile>()
        .orFail();
      expect(revoked).toMatchObject({
        deletionRequestedAt: expect.any(Date),
        retentionRevocationId: expect.any(String),
        retentionRevision: original.retentionRevision! + 1,
        expiredAt: original.expiredAt,
      });
      expect(revoked.retentionActivity).toEqual(original.retentionActivity);
      const jobs = await housekeeping.model
        .find({
          handler: 'file.cleanup',
          'work.subject.tenantId': original.tenantId ?? null,
          'work.subject.ownerUserId': String(original.user),
          'work.subject.fileId': original.file_id,
          generation: original.retentionActivity!.deadlineGeneration,
        })
        .lean();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        work: {
          handler: 'file.cleanup',
          subject: {
            tenantId: original.tenantId ?? null,
            ownerUserId: String(original.user),
            fileId: original.file_id,
          },
          deadlineGeneration: original.retentionActivity!.deadlineGeneration,
          revocationId: revoked.retentionRevocationId,
        },
        dueAt: revoked.deletionRequestedAt,
        state: 'queued',
        execution: { phase: 'awaiting_deadline' },
      });
      return revoked;
    }

    // Regression: collection admission must use the same current File eligibility as its reader.
    it.each([
      ['pending', { status: 'pending' }],
      ['rejected', { 'securityApproval.decision': 'rejected' }],
      ['missing-approval', { securityApproval: null }],
      ['obsolete-policy', { 'securityApproval.policySha256': 'c'.repeat(64) }],
      ['expired', {}],
      ['deleting', { deletionRequestedAt: new Date() }],
      ['deleted', { deletionCompletedAt: new Date() }],
      ['derived-draft', { derivedOrigin: { version: 1, purpose: 'draft' } }],
    ])('rejects %s originals without changing membership or upload holds', async (name, fields) => {
      const project = await methods.createChatProject(owner, { name: 'Eligibility' });
      const fileId = `blocked-${name}`;
      const original = await createManagedReference(fileId);
      await File.collection.updateOne(
        { _id: original._id },
        { $set: name === 'expired' ? expiredFixtureFields(original) : fields },
      );
      await expect(
        methods.addChatProjectFile(owner, project._id!.toString(), fileId),
      ).rejects.toThrow('Project file unavailable');
      expect(await methods.getChatProject(owner, project._id!.toString())).toMatchObject({
        file_ids: [],
        contextRevision: project.contextRevision,
      });
      expect(await File.findById(original._id).lean()).toMatchObject({
        expiresAt: original.expiresAt,
        temp_file_id: original.temp_file_id,
      });
    });

    it('admits current approved originals idempotently and preserves original expiry', async () => {
      process.env.CORTEX_UPLOAD_MANAGEMENT_ENABLED = 'true';
      const project = await methods.createChatProject(owner, { name: 'Approved' });
      const file = await createManagedReference('approved-original');
      const first = await methods.addChatProjectFile(owner, project._id!.toString(), file.file_id);
      const replay = await methods.addChatProjectFile(owner, project._id!.toString(), file.file_id);
      expect(replay?.file_ids).toEqual([file.file_id]);
      expect(replay?.contextRevision).toBe(first?.contextRevision);
      expect((await File.findById(file._id).lean())?.expiredAt).toEqual(file.expiredAt);
      expect(
        await createFileMethods(mongoose).getProjectFiles({
          fileIds: replay!.file_ids!,
          userId: owner,
        }),
      ).toHaveLength(1);
      await createReference('unmanaged-original');
      await expect(
        methods.addChatProjectFile(owner, project._id!.toString(), 'unmanaged-original'),
      ).rejects.toThrow('Project file unavailable');
    });

    it('scopes managed files and hold mutation to the project tenant with identical file IDs', async () => {
      const fileId = 'same-managed-id';
      const first = await tenantStorage.run({ tenantId: 'project-tenant-a' }, async () => ({
        project: await methods.createChatProject(owner, { name: 'Managed A' }),
        file: await createManagedReference(fileId),
      }));
      const second = await tenantStorage.run({ tenantId: 'project-tenant-b' }, async () => ({
        project: await methods.createChatProject(owner, { name: 'Managed B' }),
        file: await createManagedReference(fileId),
      }));
      await tenantStorage.run({ tenantId: 'project-tenant-a' }, async () => {
        expect(
          await methods.addChatProjectFile(owner, first.project._id!.toString(), fileId),
        ).toMatchObject({ file_ids: [fileId] });
        expect(await File.findById(first.file._id).lean()).not.toHaveProperty('expiresAt');
        expect(
          await methods.addChatProjectFile(owner, second.project._id!.toString(), fileId),
        ).toBeNull();
      });
      await tenantStorage.run({ tenantId: 'project-tenant-b' }, async () => {
        expect(await File.findById(second.file._id).lean()).toMatchObject({
          expiresAt: second.file.expiresAt,
          temp_file_id: second.file.temp_file_id,
        });
        expect(await methods.getChatProject(owner, second.project._id!.toString())).toMatchObject({
          file_ids: [],
          contextRevision: second.project.contextRevision,
        });
      });
    });

    it('checks eligibility again before releasing a hold after native revocation', async () => {
      const project = await methods.createChatProject(owner, { name: 'Revoked before release' });
      const file = await createManagedReference('revoked-before-release');
      const beforeRevocation = await File.findById(file._id)
        .select('+retentionActivity +retentionRevocationId')
        .lean<IMongoFile>()
        .orFail();
      const updateOne = File.updateOne.bind(File);
      const spy = jest.spyOn(File, 'updateOne').mockImplementationOnce(((
        ...args: Parameters<typeof File.updateOne>
      ) =>
        createFileMethods(mongoose)
          .revokeFileSources({ userId: owner }, [file.file_id])
          .then(() => updateOne(...args))) as unknown as typeof File.updateOne);
      try {
        await expect(
          methods.addChatProjectFile(owner, project._id!.toString(), file.file_id),
        ).rejects.toThrow('Project file unavailable');
      } finally {
        spy.mockRestore();
      }
      expect(await methods.getChatProject(owner, project._id!.toString())).toMatchObject({
        file_ids: [],
        contextRevision: project.contextRevision,
      });
      await expectCommittedRevocation(beforeRevocation);
      expect(await File.findById(file._id).lean()).toMatchObject({
        expiresAt: file.expiresAt,
        temp_file_id: file.temp_file_id,
      });
    });

    it('rolls back membership and hold release when final eligibility changes', async () => {
      const project = await methods.createChatProject(owner, { name: 'Final policy check' });
      const file = await createManagedReference('policy-after-release');
      const updateOne = File.updateOne.bind(File);
      const spy = jest.spyOn(File, 'updateOne').mockImplementationOnce(((
        ...args: Parameters<typeof File.updateOne>
      ) =>
        updateOne(...args).then((result) => {
          process.env.UPLOAD_SECURITY_POLICY_SHA256 = 'd'.repeat(64);
          return result;
        })) as unknown as typeof File.updateOne);
      try {
        await expect(
          methods.addChatProjectFile(owner, project._id!.toString(), file.file_id),
        ).rejects.toThrow('Project file unavailable');
      } finally {
        spy.mockRestore();
      }
      expect(await methods.getChatProject(owner, project._id!.toString())).toMatchObject({
        file_ids: [],
        contextRevision: project.contextRevision,
      });
      expect(await File.findById(file._id).lean()).toMatchObject({
        expiresAt: file.expiresAt,
        temp_file_id: file.temp_file_id,
      });
    });

    it.each([
      ['revoke', false],
      ['revoke', true],
      ['expire', false],
      ['expire', true],
      ['change-policy', false],
      ['change-policy', true],
    ] as const)(
      'withdraws an unavailable reference after %s during attach (replay=%s)',
      async (transition, replay) => {
        const project = await methods.createChatProject(owner, { name: 'Revoked while attaching' });
        const file = await createManagedReference('revoked-during-attach');
        if (replay) await methods.addChatProjectFile(owner, project._id!.toString(), file.file_id);
        const beforeAttach = await File.findById(file._id)
          .select('+retentionActivity +retentionRevocationId')
          .lean<IMongoFile>()
          .orFail();
        const attach = ChatProject.findOneAndUpdate.bind(ChatProject);
        const spy = jest.spyOn(ChatProject, 'findOneAndUpdate').mockImplementationOnce(((
          ...args: Parameters<typeof ChatProject.findOneAndUpdate>
        ) => {
          const query = attach(...args);
          const exec = query.exec.bind(query);
          query.exec = async () => {
            const result = await exec();
            if (transition === 'revoke') {
              await createFileMethods(mongoose).revokeFileSources({ userId: owner }, [
                file.file_id,
              ]);
            } else if (transition === 'expire') {
              await File.updateOne({ _id: file._id }, { $set: expiredFixtureFields(file) });
            } else {
              process.env.UPLOAD_SECURITY_POLICY_SHA256 = 'd'.repeat(64);
            }
            return result;
          };
          return query;
        }) as unknown as typeof ChatProject.findOneAndUpdate);
        try {
          await expect(
            methods.addChatProjectFile(owner, project._id!.toString(), file.file_id),
          ).rejects.toThrow('Project file unavailable');
        } finally {
          spy.mockRestore();
        }
        expect((await methods.getChatProject(owner, project._id!.toString()))?.file_ids).toEqual(
          [],
        );
        expect(await File.findById(file._id).lean()).not.toBeNull();
        if (transition === 'revoke') {
          const revoked = await expectCommittedRevocation(beforeAttach);
          expect(revoked.expiresAt).toEqual(beforeAttach.expiresAt);
          expect(revoked.temp_file_id).toEqual(beforeAttach.temp_file_id);
        }
      },
    );
  });

  it('persists instructions independently of description and advances semantic revisions', async () => {
    const project = await methods.createChatProject(owner, {
      name: 'Documentation',
      description: 'Human-facing summary',
      instructions: 'Use concise technical English.',
    });
    const id = project._id!.toString();
    await methods.updateChatProject(owner, id, { description: 'Renamed summary' });
    const metadataOnly = await methods.getChatProject(owner, id);
    expect(metadataOnly?.instructions).toBe('Use concise technical English.');
    expect(metadataOnly?.contextRevision).toBe(project.contextRevision);
    const updated = await methods.updateChatProject(owner, id, {
      instructions: 'Do not describe experimental features as stable.',
    });
    expect(updated?.contextRevision).toBe((project.contextRevision ?? 0) + 1);
    expect(updated?.description).toBe('Renamed summary');
    expect((await methods.getChatProject(owner, id))?.instructions).toBe(updated?.instructions);
    const unchanged = await methods.updateChatProject(owner, id, {
      name: 'Documentation workspace',
      instructions: updated?.instructions,
    });
    expect(unchanged?.contextRevision).toBe(updated?.contextRevision);
    const listed = (await methods.listChatProjects(owner)).projects[0];
    expect(listed.hasInstructions).toBe(true);
    expect(listed).not.toHaveProperty('instructions');
    expect(listed).not.toHaveProperty('file_ids');
    await methods.updateChatProject(owner, id, { instructions: '' });
    expect((await methods.listChatProjects(owner)).projects[0].hasInstructions).toBe(false);
  });

  it('preserves newer instructions and revisions when a metadata fallback follows a lost conditional update', async () => {
    const project = await methods.createChatProject(owner, {
      name: 'Original metadata',
      instructions: 'Guidance A',
    });
    const id = project._id!.toString();

    let signalConditionalMiss!: () => void;
    const conditionalMiss = new Promise<void>((resolve) => {
      signalConditionalMiss = resolve;
    });
    let releaseFallback!: () => void;
    const fallbackRelease = new Promise<void>((resolve) => {
      releaseFallback = resolve;
    });

    const findOneAndUpdate = ChatProject.findOneAndUpdate.bind(ChatProject);
    const updateSpy = jest
      .spyOn(ChatProject, 'findOneAndUpdate')
      .mockImplementation((filter, update, options) => {
        const query = findOneAndUpdate(filter, update, options);
        const queryFilter = query.getFilter();
        if (
          queryFilter._id?.toString() !== id ||
          queryFilter.user !== owner ||
          queryFilter.instructions == null
        ) {
          return query;
        }

        const exec = query.exec.bind(query);
        jest.spyOn(query, 'exec').mockImplementation(async () => {
          const result = await exec();
          if (!result) {
            signalConditionalMiss();
            await fallbackRelease;
          }
          return result;
        });
        return query;
      });

    let staleUpdate: Promise<IChatProject | null> | undefined;
    try {
      staleUpdate = methods.updateChatProject(owner, id, {
        name: 'Metadata winner',
        instructions: 'Guidance A',
      });
      await Promise.race([
        conditionalMiss,
        staleUpdate.then(() => {
          throw new Error('The unchanged instruction update did not reach its metadata fallback');
        }),
      ]);

      const concurrentWrite = await methods.updateChatProject(owner, id, {
        instructions: 'Guidance B',
      });
      expect(concurrentWrite?.instructions).toBe('Guidance B');

      releaseFallback();
      await staleUpdate;
    } finally {
      releaseFallback();
      updateSpy.mockRestore();
      await staleUpdate?.catch(() => undefined);
    }

    const persisted = await methods.getChatProject(owner, id);
    expect(persisted).toMatchObject({
      name: 'Metadata winner',
      instructions: 'Guidance B',
      contextRevision: (project.contextRevision ?? 0) + 1,
    });
  });

  it('rejects excessive instructions without truncating or changing saved context', async () => {
    const instructions = 'x'.repeat(MAX_CHAT_PROJECT_INSTRUCTIONS_LENGTH);
    const project = await methods.createChatProject(owner, { name: 'At limit', instructions });
    await expect(
      methods.updateChatProject(owner, project._id!.toString(), {
        instructions: `${instructions}x`,
      }),
    ).rejects.toThrow('Invalid project instructions');
    const saved = await methods.getChatProject(owner, project._id!.toString());
    expect(saved?.instructions).toBe(instructions);
    expect(saved?.contextRevision).toBe(project.contextRevision);
    await expect(
      methods.createChatProject(owner, { name: 'Too long', instructions: `${instructions}x` }),
    ).rejects.toThrow('Invalid project instructions');
  });

  it('initializes legacy context fields only when their normalized content changes', async () => {
    const { insertedId } = await ChatProject.collection.insertOne({
      name: 'Legacy',
      user: owner,
      conversationCount: 0,
    });
    const id = insertedId.toString();
    expect((await methods.listChatProjects(owner)).projects[0]).toMatchObject({
      hasInstructions: false,
      fileCount: 0,
    });
    await methods.updateChatProject(owner, id, { instructions: '' });
    expect((await methods.getChatProject(owner, id))?.contextRevision ?? 0).toBe(0);
    const updated = await methods.updateChatProject(owner, id, { instructions: 'New context' });
    expect(updated).toMatchObject({ instructions: 'New context', contextRevision: 1 });
    await createReference('legacy-ref');
    const attached = await methods.addChatProjectFile(owner, id, 'legacy-ref');
    expect(attached).toMatchObject({ file_ids: ['legacy-ref'], contextRevision: 2 });
  });

  it('reuses one canonical reference across Projects and conversations without copying or deleting it', async () => {
    const first = await methods.createChatProject(owner, { name: 'First' });
    const second = await methods.createChatProject(owner, { name: 'Second' });
    const deadline = new Date(Date.now() + 86_400_000);
    const original = await createReference('shared-reference', {
      expiresAt: new Date(Date.now() + 3_600_000),
      expiredAt: deadline,
    });
    const id = first._id!.toString();
    const attached = await methods.addChatProjectFile(owner, id, original.file_id);
    await methods.addChatProjectFile(owner, second._id!.toString(), original.file_id);
    await File.updateOne(
      { _id: original._id },
      { $set: { expiresAt: new Date('2026-12-01T00:00:00.000Z'), temp_file_id: 'retry-temp' } },
    );
    const duplicate = await methods.addChatProjectFile(owner, id, original.file_id);
    expect(duplicate?.file_ids).toEqual(['shared-reference']);
    expect(duplicate?.contextRevision).toBe(attached?.contextRevision);
    for (const conversationId of ['reference-chat-one', 'reference-chat-two']) {
      await createConversation(owner, conversationId, conversationId);
      await methods.assignConversationToProject(owner, conversationId, id);
    }
    const canonical = await File.findOne({ file_id: original.file_id }).lean();
    expect(canonical?._id.toString()).toBe(original._id.toString());
    expect(canonical?.filepath).toBe(original.filepath);
    expect(canonical?.expiredAt).toEqual(deadline);
    expect(canonical).not.toHaveProperty('temp_file_id');
    expect(canonical).not.toHaveProperty('expiresAt');
    expect(await File.countDocuments({})).toBe(1);
    const detached = await methods.removeChatProjectFile(owner, id, original.file_id);
    expect(detached?.file_ids).toEqual([]);
    expect(detached?.contextRevision).toBe((attached?.contextRevision ?? 0) + 1);
    const repeated = await methods.removeChatProjectFile(owner, id, original.file_id);
    expect(repeated?.contextRevision).toBe(detached?.contextRevision);
    await methods.deleteChatProject(owner, second._id!.toString());
    expect(await File.countDocuments({ file_id: original.file_id })).toBe(1);
    expect(await Conversation.countDocuments({ user: owner })).toBe(2);
  });

  it('rejects updates based on a stale contextRevision and accepts current ones', async () => {
    const project = await methods.createChatProject(owner, { name: 'Shared', instructions: 'v1' });
    const id = project._id!.toString();
    const revision = project.contextRevision;

    const first = await methods.updateChatProject(owner, id, {
      instructions: 'v2',
      contextRevision: revision,
    });
    expect(first?.instructions).toBe('v2');
    expect(first?.contextRevision).toBe((revision ?? 0) + 1);

    await expect(
      methods.updateChatProject(owner, id, { instructions: 'v3', contextRevision: revision }),
    ).rejects.toThrow('Project revision conflict');
    await expect(
      methods.updateChatProject(owner, id, { name: 'Renamed', contextRevision: revision }),
    ).rejects.toThrow('Project revision conflict');
    expect((await methods.getChatProject(owner, id))?.instructions).toBe('v2');

    const withoutRevision = await methods.updateChatProject(owner, id, { instructions: 'v4' });
    expect(withoutRevision?.instructions).toBe('v4');

    expect(
      await methods.updateChatProject(owner, new mongoose.Types.ObjectId().toString(), {
        name: 'x',
        contextRevision: 0,
      }),
    ).toBeNull();
  });

  it('commits membership with hold release and attaches nothing when the release fails', async () => {
    const project = await methods.createChatProject(owner, { name: 'Holds' });
    const id = project._id!.toString();
    const expiresAt = new Date(Date.now() + 3_600_000);
    await createReference('held', { expiresAt });
    await createReference('held-fail', { expiresAt });

    const attached = await methods.addChatProjectFile(owner, id, 'held');
    expect(attached?.file_ids).toEqual(['held']);
    expect(await File.findOne({ file_id: 'held' }).lean()).not.toHaveProperty('expiresAt');

    const spy = jest.spyOn(File, 'updateOne').mockImplementationOnce(() => {
      throw new Error('release failed');
    });
    await expect(methods.addChatProjectFile(owner, id, 'held-fail')).rejects.toThrow(
      'release failed',
    );
    spy.mockRestore();
    expect((await methods.getChatProject(owner, id))?.file_ids).toEqual(['held']);
    expect((await File.findOne({ file_id: 'held-fail' }).lean())?.expiresAt).toEqual(expiresAt);
  });

  it.each([false, true])(
    'rolls back a written hold release without changing prior membership (replay=%s)',
    async (replay) => {
      const project = await methods.createChatProject(owner, { name: 'Release rollback' });
      const file = await createReference('release-rollback');
      const before = replay
        ? await methods.addChatProjectFile(owner, project._id!.toString(), file.file_id)
        : project;
      const expiresAt = new Date(Date.now() + 3_600_000);
      await File.updateOne(
        { _id: file._id },
        { $set: { expiresAt, temp_file_id: 'rollback-temporary' } },
      );
      const updateOne = File.updateOne.bind(File);
      const spy = jest.spyOn(File, 'updateOne').mockImplementationOnce(((
        ...args: Parameters<typeof File.updateOne>
      ) =>
        updateOne(...args).then(() => {
          throw new Error('release reply failed');
        })) as unknown as typeof File.updateOne);
      try {
        await expect(
          methods.addChatProjectFile(owner, project._id!.toString(), file.file_id),
        ).rejects.toThrow('release reply failed');
      } finally {
        spy.mockRestore();
      }
      expect(await methods.getChatProject(owner, project._id!.toString())).toMatchObject({
        file_ids: before!.file_ids,
        contextRevision: before!.contextRevision,
      });
      expect(await File.findById(file._id).lean()).toMatchObject({
        expiresAt,
        temp_file_id: 'rollback-temporary',
      });
    },
  );

  it('propagates a lost commit reply without compensating the committed attachment', async () => {
    const project = await methods.createChatProject(owner, { name: 'Unknown commit' });
    const file = await createReference('commit-reply-lost', {
      expiresAt: new Date(Date.now() + 3_600_000),
      temp_file_id: 'commit-temporary',
    });
    const startSession = mongoose.startSession.bind(mongoose);
    const spy = jest.spyOn(mongoose, 'startSession').mockImplementationOnce(async (...args) => {
      const session = await startSession(...args);
      const commit = session.commitTransaction.bind(session);
      jest.spyOn(session, 'commitTransaction').mockImplementationOnce(async () => {
        await commit();
        throw new mongoose.mongo.MongoServerError({ message: 'commit reply lost' });
      });
      return session;
    });
    try {
      await expect(
        methods.addChatProjectFile(owner, project._id!.toString(), file.file_id),
      ).rejects.toThrow('commit reply lost');
    } finally {
      spy.mockRestore();
    }
    const committed = await methods.getChatProject(owner, project._id!.toString());
    expect(committed?.file_ids).toEqual([file.file_id]);
    const original = await File.findById(file._id).lean();
    expect(original).not.toHaveProperty('expiresAt');
    expect(original).not.toHaveProperty('temp_file_id');
    expect(
      await methods.addChatProjectFile(owner, project._id!.toString(), file.file_id),
    ).toMatchObject({ file_ids: [file.file_id], contextRevision: committed!.contextRevision });
  });

  it('attaches nothing when the file is deleted while the attach is in flight', async () => {
    const project = await methods.createChatProject(owner, { name: 'Racing' });
    const id = project._id!.toString();
    await createReference('gone-before-release');
    await createReference('gone-before-attach');

    const release = File.updateOne.bind(File);
    const releaseSpy = jest.spyOn(File, 'updateOne').mockImplementationOnce(((
      ...args: Parameters<typeof File.updateOne>
    ) => {
      return File.deleteOne({ file_id: 'gone-before-release' }).then(() => release(...args));
    }) as unknown as typeof File.updateOne);
    await expect(methods.addChatProjectFile(owner, id, 'gone-before-release')).rejects.toThrow(
      'Project file unavailable',
    );
    releaseSpy.mockRestore();

    const attach = ChatProject.findOneAndUpdate.bind(ChatProject);
    const attachSpy = jest.spyOn(ChatProject, 'findOneAndUpdate').mockImplementationOnce(((
      ...args: Parameters<typeof ChatProject.findOneAndUpdate>
    ) => {
      const query = attach(...args);
      const exec = query.exec.bind(query);
      query.exec = () => File.deleteOne({ file_id: 'gone-before-attach' }).then(() => exec());
      return query;
    }) as unknown as typeof ChatProject.findOneAndUpdate);
    await expect(methods.addChatProjectFile(owner, id, 'gone-before-attach')).rejects.toThrow(
      'Project file unavailable',
    );
    attachSpy.mockRestore();

    expect((await methods.getChatProject(owner, id))?.file_ids).toEqual([]);
  });

  it('rejects unauthorized, agent-scoped, unindexed, missing and expired references', async () => {
    const project = await methods.createChatProject(owner, { name: 'Private' });
    const id = project._id!.toString();
    await createReference('foreign', { user: new mongoose.Types.ObjectId(otherOwner) });
    await createReference('agent-index', { context: FileContext.agents });
    await createReference('unindexed', { embedded: false });
    await createReference('expired', { expiredAt: new Date(0) });
    for (const fileId of ['foreign', 'agent-index', 'unindexed', 'expired', 'missing']) {
      await expect(methods.addChatProjectFile(owner, id, fileId)).rejects.toThrow(
        'Project file unavailable',
      );
    }
    const orphanExpiry = new Date('2026-12-15T00:00:00.000Z');
    await createReference('orphan', { expiresAt: orphanExpiry, temp_file_id: 'orphan-temp' });
    const missingProjectId = new mongoose.Types.ObjectId().toString();
    expect(await methods.addChatProjectFile(owner, missingProjectId, 'orphan')).toBeNull();
    const orphan = await File.findOne({ file_id: 'orphan' }).lean();
    expect(orphan?.expiresAt).toEqual(orphanExpiry);
    expect(orphan?.temp_file_id).toBe('orphan-temp');
    await createReference('private');
    expect(await methods.addChatProjectFile(otherOwner, id, 'private')).toBeNull();
    expect(
      await methods.updateChatProject(otherOwner, id, { instructions: 'Injected' }),
    ).toBeNull();
    expect(await methods.removeChatProjectFile(otherOwner, id, 'private')).toBeNull();
    expect((await methods.getChatProject(owner, id))?.file_ids).toEqual([]);
  });

  it('enforces tenant isolation even for identical owner IDs', async () => {
    const id = await tenantStorage.run({ tenantId: 'project-tenant-a' }, async () => {
      const project = await methods.createChatProject(owner, {
        name: 'Tenant A',
        instructions: 'A',
      });
      await createReference('tenant-a-ref');
      await methods.addChatProjectFile(owner, project._id!.toString(), 'tenant-a-ref');
      return project._id!.toString();
    });
    await tenantStorage.run({ tenantId: 'project-tenant-b' }, async () => {
      await createReference('tenant-b-ref');
      expect(await methods.getChatProject(owner, id)).toBeNull();
      expect((await methods.listChatProjects(owner)).projects).toEqual([]);
      expect(await methods.updateChatProject(owner, id, { instructions: 'B' })).toBeNull();
      expect(await methods.addChatProjectFile(owner, id, 'tenant-b-ref')).toBeNull();
      expect(await methods.removeChatProjectFile(owner, id, 'tenant-a-ref')).toBeNull();
      expect((await methods.deleteChatProject(owner, id)).deletedCount).toBe(0);
    });
    await tenantStorage.run({ tenantId: 'project-tenant-a' }, async () => {
      await expect(methods.addChatProjectFile(owner, id, 'tenant-b-ref')).rejects.toThrow(
        'Project file unavailable',
      );
      expect(await methods.getChatProject(owner, id)).toMatchObject({
        instructions: 'A',
        file_ids: ['tenant-a-ref'],
      });
    });
  });

  it.each(['another Project', 'native usage'] as const)(
    'does not restore a losing hold after the same file succeeds in %s',
    async (promotion) => {
      // Finish model/index initialization before deliberately holding a transaction open.
      await Promise.all([ChatProject.init(), File.init()]);
      const first = await methods.createChatProject(owner, { name: 'Losing project' });
      const second = await methods.createChatProject(owner, { name: 'Successful project' });
      const shared = await createReference('concurrent-shared', {
        expiresAt: new Date(Date.now() + 3_600_000),
        temp_file_id: 'shared-temporary',
        expiredAt: new Date(Date.now() + 86_400_000),
      });
      await createReference('capacity-winner');
      let reached!: () => void;
      let resume!: () => void;
      const admissionReached = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const resumeAdmission = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const findOneAndUpdate = ChatProject.findOneAndUpdate.bind(ChatProject);
      const spy = jest
        .spyOn(ChatProject, 'findOneAndUpdate')
        .mockImplementation((filter, update, options) => {
          const query = findOneAndUpdate(filter, update, options);
          const queryFilter = query.getFilter();
          if (
            queryFilter._id?.toString() === first._id!.toString() &&
            queryFilter.file_ids?.$ne === shared.file_id
          ) {
            const exec = query.exec.bind(query);
            query.exec = async () => {
              reached();
              await resumeAdmission;
              return exec();
            };
          }
          return query;
        });
      const losing = methods.addChatProjectFile(owner, first._id!.toString(), shared.file_id, {
        maxFiles: 1,
      });
      // Observe rejection immediately while coordinating actual database operations below.
      const result = losing.then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        await Promise.race([
          admissionReached,
          result.then((error) => {
            throw error ?? new Error('Attachment settled before reaching its admission gate');
          }),
        ]);
        // Native usage consumes a permanent File; Project attachment owns hold promotion.
        expect(
          await methods.addChatProjectFile(owner, second._id!.toString(), shared.file_id),
        ).toMatchObject({ file_ids: [shared.file_id] });
        if (promotion === 'native usage') {
          expect(
            await createFileMethods(mongoose).updateFileUsage({
              file_id: shared.file_id,
              user: owner,
            }),
          ).toMatchObject({ usage: 1 });
        }
        expect(await File.findById(shared._id).lean()).not.toHaveProperty('expiresAt');
        await methods.addChatProjectFile(owner, first._id!.toString(), 'capacity-winner', {
          maxFiles: 1,
        });
        resume();
        expect(await result).toEqual(new Error('Project file limit reached'));
        expect((await methods.getChatProject(owner, first._id!.toString()))?.file_ids).toEqual([
          'capacity-winner',
        ]);
        const original = await File.findById(shared._id).lean();
        expect(original).not.toHaveProperty('expiresAt');
        expect(original).not.toHaveProperty('temp_file_id');
        expect(original?.expiredAt).toEqual(shared.expiredAt);
        if (promotion === 'another Project') {
          expect((await methods.getChatProject(owner, second._id!.toString()))?.file_ids).toEqual([
            shared.file_id,
          ]);
        } else {
          expect(original?.usage).toBe(1);
        }
      } finally {
        resume();
        await result;
        spy.mockRestore();
      }
    },
  );

  it('bounds concurrent attachment writes at the Project limit without consuming the losing hold', async () => {
    const project = await methods.createChatProject(owner, { name: 'Almost full' });
    const existingIds = Array.from(
      { length: MAX_CHAT_PROJECT_FILES - 1 },
      (_, index) => `ref-${index}`,
    );
    await ChatProject.updateOne({ _id: project._id }, { $set: { file_ids: existingIds } });
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const firstExpiry = new Date(now + day);
    const secondExpiry = new Date(now + 2 * day);
    const firstRetentionExpiry = new Date(now + 3 * day);
    const secondRetentionExpiry = new Date(now + 4 * day);
    await createReference('last-a', {
      expiresAt: firstExpiry,
      temp_file_id: 'temporary-a',
      expiredAt: firstRetentionExpiry,
    });
    await createReference('last-b', {
      expiresAt: secondExpiry,
      temp_file_id: 'temporary-b',
      expiredAt: secondRetentionExpiry,
    });

    // Delay admission execution until both contenders have completed their initial Project read.
    let admissions = 0;
    let releaseAdmissions!: () => void;
    const bothAdmissions = new Promise<void>((resolve) => {
      releaseAdmissions = resolve;
    });
    const findOneAndUpdate = ChatProject.findOneAndUpdate.bind(ChatProject);
    const admissionSpy = jest
      .spyOn(ChatProject, 'findOneAndUpdate')
      .mockImplementation((filter, update, options) => {
        const query = findOneAndUpdate(filter, update, options);
        const queryFilter = query.getFilter();
        if (
          admissions < 2 &&
          queryFilter._id?.toString() === project._id!.toString() &&
          queryFilter.file_ids != null
        ) {
          admissions += 1;
          const exec = query.exec.bind(query);
          jest.spyOn(query, 'exec').mockImplementation(async () => {
            if (admissions === 2) {
              releaseAdmissions();
            }
            await bothAdmissions;
            return await exec();
          });
        }
        return query;
      });

    try {
      const results = await Promise.allSettled(
        ['last-a', 'last-b'].map((id) =>
          methods.addChatProjectFile(owner, project._id!.toString(), id),
        ),
      );
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((result) => result.status === 'rejected');
      expect(rejected?.status === 'rejected' && rejected.reason.message).toBe(
        'Project file limit reached',
      );
    } finally {
      admissionSpy.mockRestore();
    }

    const savedProject = await methods.getChatProject(owner, project._id!.toString());
    expect(savedProject?.file_ids).toHaveLength(MAX_CHAT_PROJECT_FILES);
    const winner = savedProject?.file_ids?.includes('last-a') ? 'last-a' : 'last-b';
    const loser = winner === 'last-a' ? 'last-b' : 'last-a';
    const winnerFile = await File.findOne({ file_id: winner }).lean();
    const loserFile = await File.findOne({ file_id: loser }).lean();
    expect(winnerFile).not.toHaveProperty('expiresAt');
    expect(winnerFile).not.toHaveProperty('temp_file_id');
    expect(loserFile?.expiresAt).toEqual(loser === 'last-a' ? firstExpiry : secondExpiry);
    expect(loserFile?.temp_file_id).toBe(`temporary-${loser === 'last-a' ? 'a' : 'b'}`);
    expect(loserFile?.expiredAt).toEqual(
      loser === 'last-a' ? firstRetentionExpiry : secondRetentionExpiry,
    );
  });
});
