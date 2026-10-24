/** Real HTTP/provider/Mongo composition. Identity issuer and managed operation state are fixtures. */
const express = require('express');
const mongoose = require('mongoose');
const request = require('supertest');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { createModels, createFileLibraryMethods } = require('@librechat/data-schemas');
const { FileContext } = require('librechat-data-provider');
const { createFileLibraryHandlers } = require('./library');
const { createFileLibraryMaintenance } = require('../../services/Files/LibraryMaintenance');
const { createAppMaintenance, createManagedSourceResolver } = jest.requireActual('@librechat/api');

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('File library HTTP and native Mongo composition', () => {
  const db = new mongoose.Mongoose();
  const owner = { userId: new mongoose.Types.ObjectId().toString(), tenantId: 'library-http' };
  const foreign = { ...owner, userId: new mongoose.Types.ObjectId().toString() };
  const origin = 'https://library.example.test';
  const policy = 'c'.repeat(64);
  const previousPolicy = process.env.UPLOAD_SECURITY_POLICY_SHA256;
  const previousEnabled = process.env.CORTEX_UPLOAD_MANAGEMENT_ENABLED;
  let mongo;
  let app;
  let original;
  let runtime;
  let libraryOwner;
  let maintenance;
  const identities = { owner, foreign, 'other-tenant': { ...owner, tenantId: 'foreign-tenant' } };

  const get = (query = '', identity = 'owner') =>
    request(app)
      .get(`/api/files/library${query}`)
      .set('Authorization', `Bearer ${identity}`)
      .set('Origin', origin);
  const patch = (body, identity = 'owner') =>
    request(app)
      .patch('/api/files/library-original/library')
      .set('Authorization', `Bearer ${identity}`)
      .set('Origin', origin)
      .send(body);

  beforeAll(async () => {
    // Deliberately consume normal package outputs; missing exports are a build prerequisite.
    if (typeof createFileLibraryMethods !== 'function')
      throw new Error('The normal data-schemas build must include createFileLibraryMethods');
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await db.connect(mongo.getUri('file-library-http'));
    createModels(db);
    await Promise.all(['File', 'User', 'ChatProject'].map((name) => db.models[name].init()));
    runtime = {
      allowedOrigins: [origin],
      principal: async (req) => ({
        userId: req.user.id,
        tenantId: req.user.tenantId,
        authentication: 'verified-email',
      }),
      management: {
        get: async (_principal, fileId) => ({
          id: fileId,
          fileId,
          scope: { kind: 'personal' },
          state: 'ready',
          canUseInComposer: true,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      },
    };
    // Use the production source authorizer for this authorization-only consumer.
    runtime.sources = createManagedSourceResolver({
      allowedOrigins: runtime.allowedOrigins,
      principal: (req) => runtime.principal(req),
    });
  });

  beforeEach(async () => {
    process.env.UPLOAD_SECURITY_POLICY_SHA256 = policy;
    process.env.CORTEX_UPLOAD_MANAGEMENT_ENABLED = 'true';
    await Promise.all(
      ['File', 'User', 'ChatProject'].map((name) => db.models[name].deleteMany({})),
    );
    await db.models.User.create(
      [owner, foreign].map((identity, index) => ({
        _id: identity.userId,
        tenantId: identity.tenantId,
        email: `library-http-${index}@example.test`,
        emailVerified: true,
      })),
    );
    const accepted = Date.now() - 1000;
    original = {
      user: new mongoose.Types.ObjectId(owner.userId),
      tenantId: owner.tenantId,
      file_id: 'library-original',
      filename: 'Report.txt',
      filepath: '/private/raw-storage-path',
      object: 'file',
      type: 'text/plain',
      bytes: 8,
      usage: 0,
      embedded: true,
      source: 's3',
      context: FileContext.message_attachment,
      status: 'ready',
      uploadOperationId: 'library-original',
      storageKey: `t/${owner.tenantId}/managed-uploads/${owner.userId}/library-original.1__original`,
      retentionAcceptedAt: new Date(accepted),
      expiredAt: new Date(accepted + 600_000),
      text: 'private content',
      createdAt: new Date(accepted),
      updatedAt: new Date(accepted),
      securityApproval: {
        version: 1,
        decision: 'approved',
        policySha256: policy,
        checkedAt: new Date(accepted).toISOString(),
        scannerVersion: 'explicit-http-fixture/v1',
        coverage: { complete: true, pages: 1, parts: 1 },
        subject: {
          ...owner,
          operationId: 'library-original',
          transferGeneration: 1,
          mediaType: 'text/plain',
          bytes: 8,
          sha256: 'd'.repeat(64),
        },
      },
    };
    await db.models.File.collection.insertOne(original);
    libraryOwner = createFileLibraryMaintenance();
    maintenance = createAppMaintenance({
      readStorageProviders: () => ({
        ordinaryS3: { state: 'not-owned' },
        managedS3: { state: 'not-owned' },
      }),
      env: {},
      requiredSharedState: false,
      startupReady: () => true,
      probeDatabase: async () => false,
      probeSharedState: async () => false,
      generation: {
        closeGenerationAdmission: () => true,
        reopenGenerationAdmission: () => true,
      },
      workOwners: { fileLibrary: libraryOwner },
      fileDomainOwners: ['fileLibrary'],
      unqualifiedOwners: ['Other application writers are outside this fixture'],
    });
    const handlers = createFileLibraryHandlers({
      methods: createFileLibraryMethods(db),
      isManaged: () => true,
      getRuntime: () => runtime,
      maintenance: libraryOwner,
    });
    app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      const principal = identities[req.headers.authorization?.replace(/^Bearer /, '')];
      if (!principal) return res.sendStatus(401);
      req.user = { id: principal.userId, tenantId: principal.tenantId };
      next();
    });
    app.get('/api/files/library', handlers.list);
    app.patch('/api/files/:file_id/library', handlers.update);
  });

  afterAll(async () => {
    await db.disconnect();
    await mongo?.stop();
    for (const [key, value] of [
      ['UPLOAD_SECURITY_POLICY_SHA256', previousPolicy],
      ['CORTEX_UPLOAD_MANAGEMENT_ENABLED', previousEnabled],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('projects real native File metadata without private storage, approval or extracted content', async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body.files).toHaveLength(1);
    expect(response.body.files[0]).toMatchObject({
      file_id: 'library-original',
      filepath: '/api/files/managed/library-original',
      library: { tags: [], archivedAt: null, revision: 0 },
    });
    for (const key of ['text', 'storageKey', 'securityApproval', 'tenantId', 'uploadOperationId'])
      expect(response.body.files[0]).not.toHaveProperty(key);
    expect(response.text).not.toContain('/private/');
  });

  it.each(['foreign', 'other-tenant'])('does not expose or mutate a %s File', async (identity) => {
    expect((await get('', identity)).body).toEqual({ files: [], nextCursor: null });
    const denied = await patch({ expectedRevision: 0, archived: true }, identity);
    expect(denied.status).toBe(404);
    expect(denied.body).toEqual({ code: 'not_found' });
    expect(
      await db.models.File.collection.findOne({ file_id: 'library-original' }),
    ).not.toHaveProperty('library');
  });

  it('maps concurrent HTTP CAS and archive filtering while retaining original bytes and deadlines', async () => {
    const updates = await Promise.all(
      ['One', 'Two'].map((tag) => patch({ expectedRevision: 0, tags: [tag] })),
    );
    expect(updates.map((response) => response.status).sort()).toEqual([200, 409]);
    const success = updates.find((response) => response.status === 200).body;
    expect(success.revision).toBe(1);
    const archived = await patch({ expectedRevision: 1, archived: true });
    expect(archived.status).toBe(200);
    expect(archived.body.revision).toBe(2);
    expect((await get()).body.files).toEqual([]);
    const archivedPage = await get('?archive=archived');
    expect(archivedPage.body.files[0].library).toEqual(archived.body);
    const saved = await db.models.File.collection.findOne({ file_id: 'library-original' });
    for (const key of [
      'bytes',
      'text',
      'storageKey',
      'expiredAt',
      'retentionAcceptedAt',
      'context',
      'securityApproval',
    ])
      expect(saved[key]).toEqual(original[key]);
    expect(libraryOwner.pauseAdmissions('known-results')).toBe(true);
    expect((await libraryOwner.getMaintenanceCensus('known-results')).complete).toBe(true);
    expect(libraryOwner.resumeAdmissions('known-results')).toBe(true);
  });

  it.each(['get', 'patch'])(
    'retains the original %s library transaction after HTTP closure until session settlement',
    async (method) => {
      const held = deferred();
      const release = deferred();
      const closed = deferred();
      const originalStart = db.startSession.bind(db);
      const sessions = jest.spyOn(db, 'startSession').mockImplementationOnce(async (...args) => {
        const session = await originalStart(...args);
        const endSession = session.endSession.bind(session);
        session.endSession = async () => {
          held.resolve();
          await release.promise;
          return endSession();
        };
        return session;
      });
      const submit = (server) => {
        const pending = request(server)
          [method](method === 'get' ? '/api/files/library' : '/api/files/library-original/library')
          .set('Authorization', 'Bearer owner')
          .set('Origin', origin);
        return method === 'get' ? pending : pending.send({ expectedRevision: 0, tags: ['Held'] });
      };
      const server = app.listen(0, '127.0.0.1');
      await new Promise((resolve) => server.once('listening', resolve));
      server.once('request', (_req, res) => res.once('close', closed.resolve));
      const pending = submit(server);
      const response = pending.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      try {
        await held.promise;
        // Both GET and PATCH commit the principal version write before original session closure.
        expect((await db.models.User.findById(owner.userId).lean()).__v).toBe(1);
        expect(
          maintenance.operation('begin', {
            requestId: 'library-hold',
            identity: maintenance.identity,
            expectedRevision: 0,
          }),
        ).toBe(200);
        expect(await maintenance.externalCensus()).toEqual({
          queuedContinuations: 0,
          pendingWrites: 1,
          complete: false,
        });
        pending.abort();
        await closed.promise;
        expect(await response).toHaveProperty('error');
        expect(await libraryOwner.getMaintenanceCensus('library-hold')).toEqual({
          admissionClosed: true,
          queuedContinuations: 0,
          pendingWrites: 1,
          complete: true,
        });
        expect((await submit(server)).status).toBe(503);
        expect(sessions).toHaveBeenCalledTimes(1);
        expect((await db.models.User.findById(owner.userId).lean()).__v).toBe(1);
        let drained = false;
        const draining = libraryOwner.drain().then(() => {
          drained = true;
        });
        await Promise.resolve();
        expect(drained).toBe(false);
        release.resolve();
        await draining;
        expect(await maintenance.externalCensus()).toEqual({
          queuedContinuations: 0,
          pendingWrites: 0,
          complete: false,
        });
      } finally {
        release.resolve();
        await response;
        await libraryOwner.drain();
        await new Promise((resolve) => server.close(resolve));
        sessions.mockRestore();
      }
    },
  );

  it('keeps an original library session rejection uncertain after its HTTP response', async () => {
    const originalStart = db.startSession.bind(db);
    const sessions = jest.spyOn(db, 'startSession').mockImplementationOnce(async (...args) => {
      const session = await originalStart(...args);
      const endSession = session.endSession.bind(session);
      session.endSession = async () => {
        await endSession();
        throw new Error('Injected original session-close failure');
      };
      return session;
    });
    try {
      const response = await patch({ expectedRevision: 0, tags: ['Committed'] });
      expect(response.status).toBe(503);
      expect(response.body).toEqual({ code: 'unavailable' });
      expect(
        (await db.models.File.collection.findOne({ file_id: 'library-original' })).library.tags,
      ).toEqual(['Committed']);
      expect(libraryOwner.pauseAdmissions('failed-close')).toBe(true);
      expect(await libraryOwner.getMaintenanceCensus('failed-close')).toEqual({
        admissionClosed: true,
        queuedContinuations: 0,
        pendingWrites: 0,
        complete: false,
      });
      expect(libraryOwner.resumeAdmissions('failed-close')).toBe(false);
      await expect(libraryOwner.drain()).rejects.toThrow('FILE_LIBRARY_SETTLEMENT_UNCONFIRMED');
    } finally {
      sessions.mockRestore();
    }
  });
});
