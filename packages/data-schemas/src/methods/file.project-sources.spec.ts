import mongoose from 'mongoose';
import { FileContext } from 'librechat-data-provider';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createFileMethods } from './file';
import { createModels } from '~/models';

/** Native project queries expose a delivery hint, never source bodies or scanner proof. */
describe('project source metadata in actual Mongo projections', () => {
  let mongo: MongoMemoryServer;
  let methods: ReturnType<typeof createFileMethods>;
  const user = new mongoose.Types.ObjectId();
  const tenantId = 'project-owner-tenant';
  const owner = { userId: user.toString(), tenantId };
  const source = (file_id: string, extra: Record<string, unknown> = {}) => ({
    file_id,
    user,
    tenantId,
    filename: `${file_id}.txt`,
    filepath: `/owned/${file_id}`,
    object: 'file',
    type: 'text/plain',
    bytes: 15,
    usage: 0,
    embedded: true,
    context: FileContext.message_attachment,
    text: 'private source text',
    securityApproval: { privateFixture: 'not an actual scanner approval' },
    documentStructure: { privateFixture: 'not an actual document structure' },
    ...extra,
  });
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    createModels(mongoose);
    methods = createFileMethods(mongoose);
  });
  beforeEach(async () => {
    await mongoose.models.File.deleteMany({});
  });
  afterAll(async () => {
    await mongoose.disconnect();
    mongoose.deleteModel(/.*/);
    await mongo?.stop();
  });

  it.each(['provider', 'text', 'none'] as const)(
    'preserves %s through both explicit selects and normalizers without private fields',
    async (llmDeliveryPath) => {
      // Raw insertion lets private sentinel fields exercise the real SELECT boundary.
      await mongoose.models.File.collection.insertOne(source('reference', { llmDeliveryPath }));
      const attached = await methods.getProjectFiles({ ...owner, fileIds: ['reference'] });
      const available = await methods.getAvailableProjectFiles(owner);
      expect(attached).toHaveLength(1);
      expect(available.files).toHaveLength(1);
      for (const result of [attached[0], available.files[0]]) {
        expect(result).toMatchObject({
          file_id: 'reference',
          user: owner.userId,
          tenantId,
          llmDeliveryPath,
        });
        expect(typeof result._id).toBe('string');
        expect(result).not.toHaveProperty('text');
        expect(result).not.toHaveProperty('securityApproval');
        expect(result).not.toHaveProperty('documentStructure');
        expect(JSON.stringify(result)).not.toContain('private source');
        expect(JSON.stringify(result)).not.toContain('privateFixture');
      }
    },
  );

  it('omits absent, null and invalid stored hints without inventing a delivery mode', async () => {
    const values = [undefined, null, 'unknown', false, { mode: 'provider' }];
    await mongoose.models.File.collection.insertMany(
      values.map((value, i) =>
        source(`legacy-${i}`, value === undefined ? {} : { llmDeliveryPath: value }),
      ),
    );
    const attached = await methods.getProjectFiles({
      ...owner,
      fileIds: values.map((_, i) => `legacy-${i}`),
    });
    const available = await methods.getAvailableProjectFiles(owner);
    expect(attached).toHaveLength(values.length);
    expect(available.files).toHaveLength(values.length);
    for (const result of [...attached, ...available.files])
      expect(result).not.toHaveProperty('llmDeliveryPath');
    expect(await mongoose.models.File.collection.findOne({ file_id: 'legacy-2' })).toHaveProperty(
      'llmDeliveryPath',
      'unknown',
    );
  });

  it('retains exact owner/tenant and lifecycle filters despite a provider delivery hint', async () => {
    const now = new Date();
    const candidates = [
      source('ready', { llmDeliveryPath: 'provider' }),
      source('expired', { llmDeliveryPath: 'provider', expiredAt: new Date(now.getTime() - 1) }),
      source('foreign-owner', { llmDeliveryPath: 'provider', user: new mongoose.Types.ObjectId() }),
      source('foreign-tenant', { llmDeliveryPath: 'provider', tenantId: 'other' }),
      source('tenantless', { llmDeliveryPath: 'provider', tenantId: null }),
      source('agent-only', { llmDeliveryPath: 'provider', context: FileContext.agents }),
      source('not-indexed', { llmDeliveryPath: 'provider', embedded: false }),
      source('unapproved-managed', {
        llmDeliveryPath: 'provider',
        uploadOperationId: 'unapproved',
        retentionAcceptedAt: new Date(now.getTime() - 1),
        expiredAt: new Date(now.getTime() + 60_000),
      }),
    ];
    await mongoose.models.File.collection.insertMany(candidates);
    const attached = await methods.getProjectFiles({
      ...owner,
      fileIds: candidates.map((row) => row.file_id),
    });
    // An owned legacy expired reference remains describable as unavailable by the HTTP owner.
    expect(attached.map((row) => row.file_id).sort()).toEqual(['expired', 'ready']);
    const available = await methods.getAvailableProjectFiles({ ...owner, now });
    expect(available.files.map((row) => row.file_id)).toEqual(['ready']);
    expect(available.nextCursor).toBeNull();
    expect(JSON.stringify({ attached, available })).not.toMatch(
      /foreign-|unapproved-managed|agent-only|not-indexed/,
    );
    expect(
      (await methods.getAvailableProjectFiles({ ...owner, excludedFileIds: ['ready'], now })).files,
    ).toEqual([]);
  });

  it('preserves tenantless legacy scope without exposing any tenant or foreign owner', async () => {
    const absentTenant = source('missing-tenant', { llmDeliveryPath: 'text' });
    delete (absentTenant as { tenantId?: unknown }).tenantId;
    await mongoose.models.File.collection.insertMany([
      absentTenant,
      source('null-tenant', { tenantId: null, llmDeliveryPath: 'none' }),
      source('scoped', { llmDeliveryPath: 'provider' }),
      source('foreign', {
        tenantId: null,
        user: new mongoose.Types.ObjectId(),
        llmDeliveryPath: 'provider',
      }),
    ]);
    const unscoped = { userId: owner.userId };
    const attached = await methods.getProjectFiles({
      ...unscoped,
      fileIds: ['missing-tenant', 'null-tenant', 'scoped', 'foreign'],
    });
    const available = await methods.getAvailableProjectFiles(unscoped);
    expect(attached.map((row) => row.file_id).sort()).toEqual(['missing-tenant', 'null-tenant']);
    expect(available.files.map((row) => row.file_id).sort()).toEqual([
      'missing-tenant',
      'null-tenant',
    ]);
  });
});
