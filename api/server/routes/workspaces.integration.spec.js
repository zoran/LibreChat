/** Real HTTP/Mongo/intake/scanner/parser flow; S3, login and resource admission are fixtures. */
const path = require('node:path');
const { tmpdir } = require('node:os');
const { Readable } = require('node:stream');
const { createHash, randomUUID } = require('node:crypto');
const { mkdir, mkdtemp, readdir, rm, stat } = require('node:fs/promises');
const express = require('express');
const mongoose = require('mongoose');
const request = require('supertest');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const {
  createModels,
  createDocumentWorkspaceMethods,
  createUploadManagementRepository,
  runAsSystem,
} = require('@librechat/data-schemas');
const {
  createUploadManagement,
  createRawUploadBodyHandler,
  createSecurityWorker,
  createManagedS3Storage,
  createUnixDocumentPort,
  startDocumentSidecar,
  processNextManagedUpload,
} = require('@librechat/api');
const { createWorkspaceRouter } = require('./workspaces');

describe('Workspace HTTP saves through native security and File lifecycle', () => {
  const db = new mongoose.Mongoose();
  const origin = 'https://workspace.example.test';
  const owner = {
    userId: new mongoose.Types.ObjectId().toString(),
    tenantId: 'workspace-flow',
    authentication: 'verified-email',
  };
  const foreign = { ...owner, userId: new mongoose.Types.ObjectId().toString() };
  const worker = { hostId: 'workspace-fixture', instanceId: 'workspace-parser' };
  const policy = {
    version: 1,
    markings: [
      'VS-NfD',
      'VS-NUR FÜR DEN DIENSTGEBRAUCH',
      'VS-VERTRAULICH',
      'GEHEIM',
      'STRENG GEHEIM',
    ],
    labels: ['Einstufung'],
  };
  const policySha256 = createHash('sha256').update(JSON.stringify(policy)).digest('hex');
  const previousPolicy = process.env.UPLOAD_SECURITY_POLICY_SHA256;
  let mongo;
  let root;
  let socketDirectory;
  let intakeRoot;
  let processingRoot;
  let parserScratch;
  let scanner;
  let sidecar;
  let documents;
  let repository;
  let management;
  let methods;
  let runtime;
  let storage;
  let app;
  let objectWrites;
  const objects = new Map();
  const intakeCompletions = new Map();

  // Only physical object storage is replaced: native receipt and integrity checks remain real.
  const fakeS3Client = {
    async send(command, { abortSignal }) {
      abortSignal.throwIfAborted();
      const input = command.input;
      if (command.constructor.name === 'PutObjectCommand') {
        expect(input.IfNoneMatch).toBe('*');
        expect(objects.has(input.Key)).toBe(false);
        expect(await db.models.File.countDocuments({ file_id: input.Metadata.operation })).toBe(0);
        const chunks = [];
        for await (const chunk of input.Body) {
          abortSignal.throwIfAborted();
          chunks.push(Buffer.from(chunk));
        }
        const bytes = Buffer.concat(chunks);
        expect(bytes.length).toBe(input.ContentLength);
        objectWrites++;
        objects.set(input.Key, { bytes, versionId: `fixture-${objectWrites}` });
        return { ETag: '"fixture-etag"', VersionId: `fixture-${objectWrites}` };
      }
      if (command.constructor.name === 'GetObjectCommand') {
        const value = objects.get(input.Key);
        if (!value || value.versionId !== input.VersionId)
          throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
        return { Body: Readable.from([value.bytes]) };
      }
      throw new Error(`Unexpected fake S3 command: ${command.constructor.name}`);
    },
  };

  beforeAll(async () => {
    const threadPath = path.resolve(
      __dirname,
      '../../../packages/api/dist/uploads/security/worker-thread.cjs',
    );
    const childEntry = path.resolve(
      __dirname,
      '../../../packages/api/dist/uploads/processing/parser-child.cjs',
    );
    // Missing builds fail; this test neither rebuilds nor substitutes scanners/parsers.
    await Promise.all([stat(threadPath), stat(childEntry)]);
    const fixtureBase = process.env.UPLOAD_TEST_TMPDIR ?? tmpdir();
    const socketBase = process.env.WORKSPACE_FLOW_SOCKET_ROOT ?? tmpdir();
    await mkdir(fixtureBase, { recursive: true });
    root = await mkdtemp(path.join(fixtureBase, 'workspace-'));
    await mkdir(socketBase, { recursive: true });
    socketDirectory = await mkdtemp(path.join(socketBase, 'parser-'));
    const socketPath = path.join(socketDirectory, 'parser.sock');
    if (Buffer.byteLength(socketPath) >= 100) throw new Error('Unix socket path is too long');
    intakeRoot = path.join(root, 'intake');
    processingRoot = path.join(root, 'processing');
    parserScratch = path.join(root, 'parser-scratch');
    await Promise.all([intakeRoot, processingRoot, parserScratch].map((dir) => mkdir(dir)));
    scanner = createSecurityWorker({
      instanceId: '11111111-1111-4111-8111-111111111111',
      policy,
      policySha256,
      threadPath,
    });
    sidecar = await startDocumentSidecar({
      socketPath,
      stagingRoot: processingRoot,
      scratchRoot: parserScratch,
      childEntry,
      // Explicit fixture admission; no cgroup, container or host-isolation claim.
      resourceOwner: {
        start: async () => undefined,
        claim() {},
        release() {},
        safe: () => true,
        current: () => undefined,
        close() {},
      },
    });
    documents = createUnixDocumentPort({ socketPath, stagingRoot: processingRoot });
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await db.connect(mongo.getUri('workspace-flow'));
    createModels(db);
    await Promise.all(
      ['User', 'File', 'DocumentWorkspace', 'DocumentWorkspaceRevision'].map((name) =>
        db.models[name].init(),
      ),
    );
    process.env.UPLOAD_SECURITY_POLICY_SHA256 = policySha256;
  });

  beforeEach(async () => {
    await runAsSystem(async () => {
      for (const name of [
        'DocumentWorkspaceRevision',
        'DocumentWorkspace',
        'File',
        'UploadOperation',
        'UploadCounter',
        'User',
      ])
        if (db.models[name]) await db.models[name].deleteMany({});
      await db.models.User.create(
        [owner, foreign].map((principal, index) => ({
          _id: principal.userId,
          tenantId: principal.tenantId,
          email: `workspace-flow-${index}@example.test`,
          emailVerified: true,
        })),
      );
    });
    objects.clear();
    intakeCompletions.clear();
    objectWrites = 0;
    repository = createUploadManagementRepository(db, {
      enabled: true,
      reconciled: true,
      securityPolicySha256: policySha256,
      baseline: { originalBytes: 0, objectBytes: 0, textBytes: 0, recordBytes: 0, bundles: 0 },
    });
    await repository.initialize();
    management = createUploadManagement({
      repository,
      identity: {
        authorize: async (principal, scope) =>
          [owner, foreign].some(
            (known) =>
              principal.userId === known.userId &&
              principal.tenantId === known.tenantId &&
              principal.authentication === known.authentication,
          ) && scope.kind === 'personal',
      },
      resources: { assertSafe: async () => void (await stat(intakeRoot)) },
    });
    storage = createManagedS3Storage({
      client: fakeS3Client,
      bucket: 'synthetic-workspace-fixture',
      urlForKey: async (key) => {
        const fileId = path.basename(key).replace(/\.[1-9][0-9]*__original$/, '');
        return `/api/files/managed/${fileId}`;
      },
    });
    methods = createDocumentWorkspaceMethods(db, { securityPolicySha256: policySha256 });
    runtime = {
      allowedOrigins: [origin],
      // Two fixed authenticated principals, never a caller-supplied arbitrary owner or tenant.
      principal: async (req) => (req.headers['x-fixture-actor'] === 'foreign' ? foreign : owner),
      repository,
      management,
      storage,
    };
    app = application();
  });

  afterEach(async () => {
    await Promise.all(intakeCompletions.values());
  });

  afterAll(async () => {
    try {
      await sidecar?.close();
      if (scanner)
        expect(await scanner.close(AbortSignal.timeout(10_000))).toEqual({ complete: true });
    } finally {
      await db.disconnect();
      await mongo?.stop();
      if (root) await rm(root, { recursive: true, force: true });
      if (socketDirectory) await rm(socketDirectory, { recursive: true, force: true });
      if (previousPolicy === undefined) delete process.env.UPLOAD_SECURITY_POLICY_SHA256;
      else process.env.UPLOAD_SECURITY_POLICY_SHA256 = previousPolicy;
    }
  });

  function application() {
    const instance = express();
    instance.use(
      '/api/workspaces',
      createWorkspaceRouter({ enabled: () => true, getRuntime: () => runtime, methods }),
    );
    // Test mounting of the real raw handler; authentication replaces only native session issuance.
    const bodyHandler = createRawUploadBodyHandler({
      management,
      principal: runtime.principal,
      storage,
      security: scanner,
      worker,
      stagingRoot: intakeRoot,
      claimBytes: management.claimWorkBytes,
      completeBytes: management.completeWorkBytes,
      deadlineMs: 15_000,
    });
    instance.put('/fixture/intake/:id/body', (req, res, next) => {
      const completion = bodyHandler(req, res, next);
      intakeCompletions.set(req.params.id, completion);
      completion.catch(next);
    });
    return instance;
  }
  const post = (suffix, body, actor = 'owner') =>
    request(app)
      .post(`/api/workspaces${suffix}`)
      .set('Origin', origin)
      .set('x-fixture-actor', actor)
      .send(body);
  const get = (suffix, actor = 'owner', instance = app) =>
    request(instance)
      .get(`/api/workspaces${suffix}`)
      .set('Sec-Fetch-Site', 'same-origin')
      .set('x-fixture-actor', actor);
  async function create() {
    const response = await post('', { format: 'markdown' });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ revision: 0, headFileId: null });
    return response.body.workspaceId;
  }
  async function reserve(workspaceId, baseRevision, bytes) {
    const response = await post(`/${workspaceId}/saves`, {
      baseRevision,
      declaredBytes: bytes.length,
      idempotencyKey: randomUUID(),
    });
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ state: 'waiting', canUseInComposer: false });
    expect(await db.models.File.countDocuments({ file_id: response.body.id })).toBe(0);
    return response.body.id;
  }
  async function intake(id, bytes) {
    const response = await request(app)
      .put(`/fixture/intake/${id}/body`)
      .set('Content-Type', 'application/octet-stream')
      .set('Content-Length', String(bytes.length))
      .set('x-upload-filename', encodeURIComponent('Synthetischer Entwurf.txt'))
      .send(bytes);
    // The HTTP response precedes the handler's finally block; join its real cleanup, not a timer.
    expect(intakeCompletions.has(id)).toBe(true);
    await intakeCompletions.get(id);
    expect(await readdir(intakeRoot)).toEqual([]);
    return response;
  }
  async function ready(id, bytes) {
    expect((await intake(id, bytes)).status).toBe(202);
    const approved = await db.models.File.findOne({ file_id: id })
      .select('+securityApproval')
      .lean();
    expect(approved.securityApproval).toMatchObject({
      decision: 'approved',
      subject: { operationId: id, bytes: bytes.length },
    });
    const processed = await processNextManagedUpload(
      { management, storage, documents, worker, stagingRoot: processingRoot },
      AbortSignal.timeout(15_000),
    );
    expect(processed).toMatchObject({ claimed: true, operation: { id, state: 'ready' } });
    expect(await readdir(processingRoot)).toEqual([]);
    expect(await readdir(parserScratch)).toEqual([]);
    expect(await management.get(owner, id)).toMatchObject({
      state: 'ready',
      cleanupPending: false,
      canUseInComposer: false,
    });
  }

  it('creates, approves, parses and commits two native revisions and reloads exact original bytes', async () => {
    const workspaceId = await create();
    const versions = [
      Buffer.from('# Synthetischer Entwurf\nEin freigegebener deutscher Testtext.\n'),
      Buffer.from('# Überarbeiteter Testentwurf\nEine bewusst geänderte zweite Fassung.\n'),
    ];
    const ids = [];
    for (const [baseRevision, bytes] of versions.entries()) {
      const id = await reserve(workspaceId, baseRevision, bytes);
      ids.push(id);
      expect((await post(`/${workspaceId}/revisions`, { baseRevision, fileId: id })).status).toBe(
        404,
      );
      await ready(id, bytes);
      const status = await get(`/${workspaceId}/saves/${id}?baseRevision=${baseRevision}`);
      expect(status.status).toBe(200);
      expect(status.body).toMatchObject({ id, state: 'ready' });
      expect(JSON.stringify(status.body)).not.toMatch(/securityApproval|derivedOrigin|storageKey/);
      const committed = await post(`/${workspaceId}/revisions`, { baseRevision, fileId: id });
      expect(committed.status).toBe(200);
      expect(committed.body).toMatchObject({ revision: baseRevision + 1, fileId: id });
    }
    const reloadedApp = application();
    expect((await get(`/${workspaceId}`, 'owner', reloadedApp)).body).toMatchObject({
      revision: 2,
      headFileId: ids[1],
    });
    for (const [index, bytes] of versions.entries()) {
      const original = await get(
        `/${workspaceId}/revisions/${index + 1}/content`,
        'owner',
        reloadedApp,
      );
      expect(original.status).toBe(200);
      expect(original.headers['cache-control']).toContain('no-store');
      expect(original.headers['content-type']).toBe('application/octet-stream');
      expect(original.body).toEqual(bytes);
    }
    const file = await db.models.File.findOne({ file_id: ids[1] }).select('+derivedOrigin').lean();
    expect(file.derivedOrigin.directSourceFileIds).toEqual([ids[0]]);
    expect(file.text).toBe(versions[1].toString('utf8'));
    const metadata = JSON.stringify(await db.models.DocumentWorkspace.find({}).lean());
    expect(metadata).not.toContain('deutscher Testtext');
    expect(metadata).not.toContain('zweite Fassung');
    expect(await db.models.DocumentWorkspaceRevision.countDocuments({ workspaceId })).toBe(2);
  });

  it('replays an exact native receipt after a lost acknowledgement and an advanced head', async () => {
    const workspaceId = await create();
    const firstBytes = Buffer.from('Bestätigte erste Fassung.');
    const secondBytes = Buffer.from('Neuere Fassung eines anderen Editors.');
    const first = await reserve(workspaceId, 0, firstBytes);
    await ready(first, firstBytes);
    const nativeCommit = methods.commitDocumentWorkspaceVersion;
    let loseAcknowledgement = true;
    methods.commitDocumentWorkspaceVersion = async (...args) => {
      const result = await nativeCommit(...args);
      if (loseAcknowledgement) {
        loseAcknowledgement = false;
        // The Mongo commit is real; only its return channel fails after completion.
        throw Object.assign(new Error('Lost committed acknowledgement'), { code: 'unavailable' });
      }
      return result;
    };
    expect(
      (await post(`/${workspaceId}/revisions`, { baseRevision: 0, fileId: first })).status,
    ).toBe(503);
    expect((await get(`/${workspaceId}`)).body).toMatchObject({ revision: 1, headFileId: first });
    const second = await reserve(workspaceId, 1, secondBytes);
    await ready(second, secondBytes);
    expect(
      (await post(`/${workspaceId}/revisions`, { baseRevision: 1, fileId: second })).status,
    ).toBe(200);
    methods = createDocumentWorkspaceMethods(db, { securityPolicySha256: policySha256 });
    app = application();
    const replay = await post(`/${workspaceId}/revisions`, { baseRevision: 0, fileId: first });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({
      workspaceId,
      revision: 1,
      fileId: first,
      createdAt: expect.any(String),
      expiresAt: expect.any(String),
    });
    expect((await get(`/${workspaceId}`)).body).toMatchObject({ revision: 2, headFileId: second });
    expect((await get(`/${workspaceId}/revisions/1/content`)).body).toEqual(firstBytes);
    expect(
      (await post(`/${workspaceId}/revisions`, { baseRevision: 0, fileId: second })).status,
    ).toBe(409);
    expect(await db.models.DocumentWorkspaceRevision.countDocuments({ workspaceId })).toBe(2);
    expect(await db.models.File.countDocuments({})).toBe(2);
    expect(objectWrites).toBe(2);
  });

  it.each([
    [
      'classified',
      Buffer.from('Einstufung: VS-VERTRAULICH\nSynthetisches Testdokument.'),
      'security_rejected',
    ],
    ['uninspectable', Buffer.from([0xc3, 0x28]), 'security_uninspectable'],
  ])('never stores, processes or commits %s bytes', async (_kind, bytes, code) => {
    const workspaceId = await create();
    const id = await reserve(workspaceId, 0, bytes);
    const rejected = await intake(id, bytes);
    expect(rejected.status).toBe(422);
    expect(rejected.body).toEqual({ code });
    expect(objectWrites).toBe(0);
    expect(objects.size).toBe(0);
    expect(await db.models.File.countDocuments({ file_id: id })).toBe(0);
    expect(
      await processNextManagedUpload(
        { management, storage, documents, worker, stagingRoot: processingRoot },
        AbortSignal.timeout(5_000),
      ),
    ).toEqual({ claimed: false });
    expect((await post(`/${workspaceId}/revisions`, { baseRevision: 0, fileId: id })).status).toBe(
      404,
    );
    expect((await get(`/${workspaceId}/revisions/1/content`)).status).toBe(404);
    expect((await get(`/${workspaceId}`)).body).toMatchObject({ revision: 0, headFileId: null });
    expect(await db.models.DocumentWorkspaceRevision.countDocuments({ workspaceId })).toBe(0);
  });

  it('keeps ready saves and originals private to the actual native owner', async () => {
    const workspaceId = await create();
    const bytes = Buffer.from('Synthetischer privater Entwurf.');
    const id = await reserve(workspaceId, 0, bytes);
    await ready(id, bytes);
    expect((await get(`/${workspaceId}`, 'foreign')).status).toBe(404);
    expect((await get(`/${workspaceId}/saves/${id}?baseRevision=0`, 'foreign')).status).toBe(404);
    expect(
      (await post(`/${workspaceId}/revisions`, { baseRevision: 0, fileId: id }, 'foreign')).status,
    ).toBe(404);
    expect((await get('', 'foreign')).body.workspaces).toEqual([]);
    expect((await post(`/${workspaceId}/revisions`, { baseRevision: 0, fileId: id })).status).toBe(
      200,
    );
    expect((await get(`/${workspaceId}/revisions/1/content`, 'foreign')).status).toBe(404);
    expect((await get(`/${workspaceId}/revisions/1/content`)).body).toEqual(bytes);
  });

  it('rejects a late ready save after another client commits the same base revision', async () => {
    const workspaceId = await create();
    const firstBytes = Buffer.from('Synthetische bestätigte Fassung.');
    const lateBytes = Buffer.from('Synthetisches verspätetes Ergebnis.');
    const first = await reserve(workspaceId, 0, firstBytes);
    const late = await reserve(workspaceId, 0, lateBytes);
    await ready(first, firstBytes);
    await ready(late, lateBytes);
    expect(
      (await post(`/${workspaceId}/revisions`, { baseRevision: 0, fileId: first })).status,
    ).toBe(200);
    const conflicted = await post(`/${workspaceId}/revisions`, { baseRevision: 0, fileId: late });
    expect(conflicted.status).toBe(409);
    expect(conflicted.body).toEqual({ code: 'revision_conflict' });
    expect((await get(`/${workspaceId}/saves/${late}?baseRevision=0`)).status).toBe(409);
    expect((await get(`/${workspaceId}`)).body).toMatchObject({ revision: 1, headFileId: first });
    expect((await get(`/${workspaceId}/revisions/1/content`)).body).toEqual(firstBytes);
    expect(await db.models.DocumentWorkspaceRevision.countDocuments({ workspaceId })).toBe(1);
  });
});
