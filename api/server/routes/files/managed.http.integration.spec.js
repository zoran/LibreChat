/** Real HTTP + public built owners + Mongo transactions + managed S3 transport, all on loopback. */
const assert = require('node:assert/strict');
const test =
  typeof globalThis.test === 'function'
    ? (name, options, run) => globalThis.test(name, run, options.timeout)
    : require('node:test').test;
const { createRequire } = require('node:module');
const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { createHash, randomUUID } = require('node:crypto');

// The isolated qualification runner selects the checkout; normal execution uses this file's root.
const workspace = process.env.CORTEX_HTTP_WORKSPACE || path.resolve(__dirname, '../../../..');
const fromWorkspace = createRequire(path.join(workspace, 'package.json'));
Object.assign(process.env, {
  NODE_ENV: 'test',
  LOG_TO_FILE: 'false',
  CONSOLE_LOG_LEVEL: 'silent',
  AUTH_MODE: 'email_code',
  EMAIL_CODE_TENANT_ID: 'read-http-fixture',
  EMAIL_CODE_ALLOWED_DOMAINS: 'example.test',
  EMAIL_CODE_POLICY_VERSION: '1',
  EMAIL_CODE_HMAC_KEY: 'synthetic-read-http-hmac-key-only-000000',
  JWT_SECRET: 'synthetic-read-http-signing-key-only',
  UPLOAD_SECURITY_POLICY_SHA256: 'c'.repeat(64),
  CORTEX_UPLOAD_MANAGEMENT_ENABLED: 'true',
  MONGOMS_RUNTIME_DOWNLOAD: 'false',
});
const express = fromWorkspace('express');
const mongoose = fromWorkspace('mongoose');
const jwt = fromWorkspace('jsonwebtoken');
const { Registry } = fromWorkspace('prom-client');
const { S3Client } = fromWorkspace('@aws-sdk/client-s3');
const { MongoMemoryReplSet } = fromWorkspace('mongodb-memory-server');
const {
  createModels,
  createMethods,
  createUploadManagementRepository,
  runAsSystem,
  tenantStorage,
} = fromWorkspace('@librechat/data-schemas');
const { createManagedFileHandlers, createManagedS3Storage } = fromWorkspace('@librechat/api');
const { serializeManagedFileReadPreview } = fromWorkspace('librechat-data-provider');
const { createUploadComposition } = fromWorkspace('./api/server/services/Uploads');
const contentDisposition = fromWorkspace('content-disposition');

const DAY = 86400000;
const policy = 'c'.repeat(64);
const worker = { hostId: 'read-http-fixture-cpu', instanceId: 'read-http-fixture-app' };
const origin = 'https://read.example.test';
const digest = (value) => createHash('sha256').update(value).digest('hex');
const payload = Buffer.concat([Buffer.alloc(262144, 65), Buffer.from('private final text')]);
const integrity = {
  version: 1,
  algorithm: 'sha256',
  sha256: digest(payload),
  chunkBytes: 262144,
  chunkSha256: [digest(payload.subarray(0, 262144)), digest(payload.subarray(262144))],
};
const forbiddenPort = () => {
  throw new Error('An inactive fixture port was invoked');
};

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function until(check) {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, 'bounded fixture observation timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  if (!server?.listening) return;
  const closed = new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  server.closeAllConnections();
  await closed;
}
function custody(mongo, status) {
  const actors = mongo.servers.flatMap((server) => {
    const info = server.instanceInfo;
    return [info?.instance.mongodProcess, info?.instance.killerProcess]
      .filter(Boolean)
      .map((child) => {
        const stat = fs.readFileSync(`/proc/${child.pid}/stat`, 'utf8').split(') ')[1].split(' ');
        return {
          pid: child.pid,
          parentPid: Number(stat[1]),
          startTicks: stat[19],
          bootId: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
          dbPath: info.dbPath,
          port: info.port,
        };
      });
  });
  return { status, actors };
}
function observe(value) {
  if (process.env.CORTEX_HTTP_ACTOR_HOOK)
    execFileSync('python3', [process.env.CORTEX_HTTP_ACTOR_HOOK], { input: JSON.stringify(value) });
}

test(
  'managed read crosses HTTP, durable File authority and real S3 HTTP transport',
  { timeout: 120000 },
  async () => {
    for (const value of [
      createModels,
      createMethods,
      createUploadManagementRepository,
      createManagedFileHandlers,
      createManagedS3Storage,
      serializeManagedFileReadPreview,
    ])
      assert.equal(typeof value, 'function', 'current public package build is required');
    const db = new mongoose.Mongoose();
    let mongo, runtime, client, storageServer, appServer, mongoCustody;
    let repository, fileId, receipt, structure, baseline, owner, other;
    let nextStorageMode = 'complete';
    const storageRequests = [];
    const storageResponses = new Set();
    const completionCommits = [];
    const completionUpdates = new Map();
    const commitRequests = new Map();
    const responseEnds = [];
    const report = {
      fixture: 'loopback HTTP + installed Mongo + actual public package owners',
      phases: [],
    };
    let activeTail;
    const transactionKey = (command) => JSON.stringify([command.lsid, command.txnNumber]);
    // Cleanup rejection retains its existing precedence over a body failure.
    const settleFixture = async () => {
      activeTail?.resolve();
      const settled = await Promise.allSettled([close(appServer), close(storageServer)]);
      client?.destroy();
      if (runtime)
        settled.push(
          await Promise.resolve(runtime.close(AbortSignal.timeout(10000))).then(
            () => ({ status: 'fulfilled' }),
            (reason) => ({ status: 'rejected', reason }),
          ),
        );
      await db.disconnect();
      await mongo?.stop();
      if (mongoCustody) {
        mongoCustody.status = 'settled';
        mongoCustody.remainingActors = mongoCustody.actors.filter((actor) =>
          fs.existsSync(`/proc/${actor.pid}`),
        );
        mongoCustody.remainingPaths = [
          ...new Set(mongoCustody.actors.map((actor) => actor.dbPath)),
        ].filter(fs.existsSync);
        observe(mongoCustody);
        report.settlement = mongoCustody;
        assert.deepEqual(mongoCustody.remainingActors, []);
        assert.deepEqual(mongoCustody.remainingPaths, []);
      }
      if (process.env.CORTEX_HTTP_EVIDENCE)
        fs.writeFileSync(process.env.CORTEX_HTTP_EVIDENCE, JSON.stringify(report, null, 2) + '\n');
      for (const result of settled) if (result.status === 'rejected') throw result.reason;
    };
    try {
      mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, ip: '127.0.0.1' } });
      mongoCustody = custody(mongo, 'running');
      observe(mongoCustody);
      await db.connect(mongo.getUri('managed_read_http'), { monitorCommands: true });
      db.connection.getClient().on('commandStarted', (event) => {
        const key = transactionKey(event.command);
        if (event.commandName === 'update') {
          for (const update of event.command.updates ?? []) {
            const completion = update.u?.$set?.completion;
            if (completion) completionUpdates.set(key, JSON.parse(JSON.stringify(completion)));
          }
        }
        if (event.commandName === 'commitTransaction' && completionUpdates.has(key))
          commitRequests.set(event.requestId, { key, completion: completionUpdates.get(key) });
      });
      db.connection.getClient().on('commandSucceeded', (event) => {
        const committed = commitRequests.get(event.requestId);
        if (event.commandName === 'commitTransaction' && committed) {
          completionCommits.push({
            ...committed.completion,
            observedAt: process.hrtime.bigint().toString(),
          });
          completionUpdates.delete(committed.key);
          commitRequests.delete(event.requestId);
        }
      });
      createModels(db);
      const methods = createMethods(db);
      await Promise.all(['File', 'User', 'Session'].map((name) => db.models[name].init()));
      repository = createUploadManagementRepository(db, {
        enabled: true,
        reconciled: true,
        securityPolicySha256: policy,
        baseline: { originalBytes: 0, objectBytes: 0, textBytes: 0, recordBytes: 0, bundles: 0 },
      });
      await runAsSystem(() => repository.initialize());

      async function identity(label) {
        const userId = new mongoose.Types.ObjectId().toString();
        const sessionId = new mongoose.Types.ObjectId().toString();
        const at = Date.now();
        await runAsSystem(async () => {
          await db.models.User.create({
            _id: userId,
            tenantId: 'read-http-fixture',
            provider: 'email_code',
            email: `${label}@example.test`,
            emailVerified: true,
            authVersion: 0,
          });
          await db.models.Session.create({
            _id: sessionId,
            user: userId,
            tenantId: 'read-http-fixture',
            refreshTokenHash: digest(label),
            expiration: new Date(at + DAY),
            idleExpiresAt: new Date(at + DAY),
            authMethod: 'email_code',
            authPolicyVersion: 1,
            authVersion: 0,
            refreshGeneration: 0,
            authCreatedAt: new Date(at),
          });
        });
        const token = jwt.sign(
          {
            id: userId,
            sessionId,
            tenantId: 'read-http-fixture',
            authMethod: 'email_code',
            authVersion: 0,
            policyVersion: 1,
            issuedAtMs: at,
            tokenUse: 'access',
            generation: 0,
          },
          process.env.JWT_SECRET,
          { algorithm: 'HS256', expiresIn: 300 },
        );
        return {
          principal: { tenantId: 'read-http-fixture', userId, authentication: 'verified-email' },
          token,
        };
      }
      owner = await identity('owner');
      other = await identity('other');
      fileId = randomUUID();
      const at = Date.now();
      const p = owner.principal;
      await runAsSystem(async () => {
        await repository.reserve(
          p,
          {
            operationId: fileId,
            idempotencyKey: randomUUID(),
            mediaType: 'text/plain',
            declaredBytes: payload.length,
            fingerprint: JSON.stringify([{ kind: 'personal' }, 'text/plain', payload.length]),
          },
          at,
        );
        const lease = await repository.claim({
          kind: 'transfer',
          principal: p,
          operationId: fileId,
          worker,
          now: at,
        });
        assert.ok(lease);
        const execution = {
          version: 2,
          custody: { kind: 'none' },
          attemptId: `${fileId}.${lease.generation}`,
          instanceId: '11111111-1111-4111-8111-111111111111',
          executionId: '22222222-2222-4222-8222-222222222222',
          expiresAt: new Date(at + 60000).toISOString(),
        };
        await repository.bindSecurityExecution(lease, execution, at);
        await repository.settleSecurityExecution(
          lease,
          { execution, writerStopped: true, transientDataRemoved: true },
          at,
        );
        receipt = {
          outcome: 'durable',
          bytes: payload.length,
          source: 's3',
          filepath: `/api/files/managed/${fileId}`,
          storageKey: `t/${p.tenantId}/managed-uploads/${p.userId}/${fileId}.${lease.generation}__original`,
          integrity,
          versionId: 'fixture-recorded-version',
          etag: 'fixture-etag',
        };
        const approval = {
          version: 1,
          decision: 'approved',
          policySha256: policy,
          subject: {
            tenantId: p.tenantId,
            userId: p.userId,
            operationId: fileId,
            transferGeneration: lease.generation,
            mediaType: 'text/plain',
            bytes: payload.length,
            sha256: integrity.sha256,
          },
          scannerVersion: 'fixture-1',
          checkedAt: new Date(at).toISOString(),
          coverage: { complete: true, pages: 1, parts: 1 },
        };
        await repository.accept(p, lease, receipt, approval, { filename: 'private-note.txt' }, at);
        const gone = (value) => ({
          operationId: value.operationId,
          generation: value.generation,
          writerStopped: true,
          localCopiesAbsent: true,
          originalAbsent: false,
          textAndHistoryRemoved: false,
        });
        await repository.confirmCleanup(gone(lease), at);
        const processing = await repository.claim({ kind: 'processing', worker, now: at });
        assert.ok(processing);
        await repository.bindProcessingExecution(
          processing,
          {
            attemptId: `${fileId}.${processing.generation}`,
            instanceId: 'fixture-parser',
            expiresAt: new Date(at + 60000).toISOString(),
          },
          at,
        );
        const text = 'Validated preview — private fixture.';
        structure = {
          version: 1,
          source: { sha256: integrity.sha256, bytes: payload.length, mediaType: 'text/plain' },
          extractor: { name: 'fixture', version: '1' },
          pages: [],
          elements: [
            { id: 'e1', kind: 'paragraph', start: 0, end: text.length, page: null, parentId: null },
          ],
          quality: { status: 'complete', warnings: [] },
        };
        await repository.publish(processing, { text, structure, writerStopped: true }, at);
        await repository.confirmCleanup(gone(processing), at);
      });
      async function snapshot() {
        return runAsSystem(async () => {
          const f = await db.models.File.findOne({ file_id: fileId })
            .select('+retentionActivity +documentStructure')
            .lean();
          const u = await db.models.UploadOperation.findById(fileId).lean();
          const rows = await db.models.FileReadReceipt.find({ fileId }).lean();
          return {
            deadline: f.expiredAt.getTime(),
            uploadDeadline: u.expiresAt,
            reads: f.retentionActivity.readCount,
            processing: f.retentionActivity.processingCount,
            generation: f.retentionActivity.deadlineGeneration,
            completed: rows.filter((row) => row.completion).length,
            receipts: rows.length,
            text: f.text,
            structure: f.documentStructure,
          };
        });
      }
      async function delta(reads) {
        const current = await snapshot();
        assert.equal(current.deadline, baseline.deadline + reads * 7 * DAY);
        assert.equal(current.uploadDeadline, current.deadline);
        assert.equal(current.reads, reads);
        assert.equal(current.processing, 1);
        assert.equal(current.generation, baseline.generation + reads);
        assert.equal(current.completed, reads);
        return current;
      }
      baseline = await snapshot();
      assert.equal(baseline.deadline, at + 35 * DAY);
      assert.equal(baseline.reads, 0);
      assert.equal(baseline.processing, 1);
      assert.equal(baseline.receipts, 0);

      storageServer = http.createServer(async (req, res) => {
        storageResponses.add(res);
        res.once('close', () => storageResponses.delete(res));
        const url = new URL(req.url, 'http://127.0.0.1');
        const mode = nextStorageMode;
        nextStorageMode = 'complete';
        storageRequests.push({
          method: req.method,
          path: decodeURIComponent(url.pathname),
          versionId: url.searchParams.get('versionId'),
          signed: /^AWS4-HMAC-SHA256 /.test(req.headers.authorization || ''),
          mode,
        });
        if (
          req.method !== 'GET' ||
          decodeURIComponent(url.pathname) !== `/read-fixture/${receipt.storageKey}` ||
          url.searchParams.get('versionId') !== receipt.versionId
        ) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': payload.length,
          ETag: 'fixture-etag',
          'x-amz-version-id': receipt.versionId,
        });
        if (mode === 'held') {
          activeTail = deferred();
          res.write(payload.subarray(0, 262144));
          await activeTail.promise;
          if (!res.destroyed) res.end(payload.subarray(262144));
        } else {
          const body = Buffer.from(payload);
          if (mode === 'corrupt') body[0] ^= 1;
          res.end(body);
        }
      });
      const storageURL = await listen(storageServer);
      client = new S3Client({
        region: 'us-east-1',
        endpoint: storageURL,
        forcePathStyle: true,
        maxAttempts: 1,
        credentials: {
          accessKeyId: 'SYNTHETIC-LOOPBACK-ONLY',
          secretAccessKey: 'synthetic-loopback-only',
        },
      });
      const storage = createManagedS3Storage({ client, bucket: 'read-fixture' });
      runtime = await createUploadComposition({
        repository,
        models: methods,
        registry: new Registry(),
        worker,
        platform: {
          resources: { assertSafe: forbiddenPort },
          expected: [{ node: worker.hostId, pool: 'app', signal: 'cpu' }],
          snapshots: { refresh: forbiddenPort, current: forbiddenPort },
          hardGuards: forbiddenPort,
        },
        storage,
        documents: { cancel: forbiddenPort },
        security: {
          policySha256: policy,
          prepare: forbiddenPort,
          inspect: forbiddenPort,
          cancel: forbiddenPort,
        },
        stagingRoot: process.env.TMPDIR || require('node:os').tmpdir(),
        allowedOrigins: [origin],
      });
      assert.equal(runtime.fileReads, repository.fileReads);
      assert.deepEqual(runtime.fileReadWorker, worker);
      assert.ok(Object.isFrozen(runtime.fileReadWorker));
      const handlers = createManagedFileHandlers({
        getRuntime: () => runtime,
        getFiles: methods.getFiles,
        runAsSystem,
        getContentDisposition: contentDisposition,
      });
      const app = express();
      app.use(async (req, res, next) => {
        try {
          const principal = await runtime.principal(req);
          req.user = { id: principal.userId, tenantId: principal.tenantId, provider: 'email_code' };
          // Pure synchronous observation: preserve the real end() and do not delay transport.
          const end = res.end;
          res.end = function (...args) {
            responseEnds.push({
              path: req.path,
              readId: req.headers['x-cortex-file-read'],
              status: res.statusCode,
              commits: completionCommits.length,
              observedAt: process.hrtime.bigint().toString(),
            });
            return end.apply(this, args);
          };
          tenantStorage.run({ tenantId: principal.tenantId, userId: principal.userId }, next);
        } catch {
          res.sendStatus(401);
        }
      });
      app.get('/api/files', handlers.list);
      app.get('/api/files/managed/:id', handlers.download);
      app.get('/api/files/download-url/:userId/:file_id', handlers.downloadURL);
      app.get('/api/files/:file_id/preview', handlers.preview);
      appServer = http.createServer(app);
      const appURL = await listen(appServer);
      report.endpoints = { app: appURL, storage: storageURL };

      function request(route, { identity = owner, ticket, method = 'GET', onChunk } = {}) {
        let req;
        const result = new Promise((resolve, reject) => {
          req = http.request(
            new URL(route, appURL),
            {
              method,
              agent: false,
              headers: {
                Authorization: `Bearer ${identity.token}`,
                Origin: origin,
                'Sec-Fetch-Site': 'same-origin',
                ...(ticket ? { 'X-Cortex-File-Read': ticket.readId } : {}),
              },
            },
            (res) => {
              const chunks = [];
              res.on('data', (chunk) => {
                chunks.push(chunk);
                onChunk?.(chunk, req);
              });
              res.once('error', reject);
              res.once('end', () =>
                resolve({
                  status: res.statusCode,
                  headers: res.headers,
                  body: Buffer.concat(chunks),
                  complete: res.complete,
                }),
              );
            },
          );
          req.once('error', reject);
          req.end();
        });
        return { result, abort: () => req.destroy(new Error('Intentional fixture client abort')) };
      }
      const get = async (route, options) => request(route, options).result;
      const preparation = (identity = owner, representation = 'original') =>
        `/api/files/download-url/${identity.principal.userId}/${fileId}?read=1&representation=${representation}`;
      const original = `/api/files/managed/${fileId}`;
      const preview = `/api/files/${fileId}/preview`;
      async function admit(representation = 'original') {
        const response = await get(preparation(owner, representation));
        assert.equal(response.status, 200, response.body.toString());
        const ticket = JSON.parse(response.body);
        assert.match(ticket.readId, /^[A-Za-z0-9_-]{43}$/);
        return ticket;
      }
      const metadata = await get(preview);
      assert.equal(metadata.status, 200);
      assert.deepEqual(JSON.parse(metadata.body), { file_id: fileId, status: 'ready' });
      assert.equal((await get(preparation(), { method: 'HEAD' })).status, 405);
      assert.deepEqual(await snapshot(), baseline);
      assert.equal(storageRequests.length, 0);
      report.phases.push('metadata and HEAD do not create reads or fetch original bytes');

      const ticket = await admit();
      nextStorageMode = 'held';
      let received = 0;
      const download = request(original, {
        ticket,
        onChunk: (chunk) => {
          received += chunk.length;
        },
      });
      await until(() => activeTail && received > 0);
      await delta(0);
      assert.ok(received < payload.length);
      assert.equal(completionCommits.length, 0);
      activeTail.resolve();
      const downloaded = await download.result;
      assert.equal(downloaded.status, 200);
      assert.equal(downloaded.complete, true);
      assert.equal(Number(downloaded.headers['content-length']), payload.length);
      assert.deepEqual(downloaded.body, payload);
      assert.equal(digest(downloaded.body), integrity.sha256);
      const first = await delta(1);
      assert.equal(completionCommits.length, 1);
      const terminal = responseEnds.find(
        (entry) => entry.readId === ticket.readId && entry.path === original,
      );
      assert.equal(terminal.commits, 1);
      assert.ok(BigInt(completionCommits[0].observedAt) < BigInt(terminal.observedAt));
      assert.equal(completionCommits[0].verifiedBytes, payload.length);
      assert.equal(completionCommits[0].contentSha256, integrity.sha256);
      report.phases.push(
        'exact original body; durable completion committed before real HTTP end; current +7 days',
      );

      assert.equal((await get(preparation(), { ticket })).status, 204);
      assert.deepEqual((await get(original, { ticket })).body, payload);
      assert.deepEqual(await snapshot(), first);
      assert.equal(completionCommits.length, 1);
      const previewTicket = await admit('preview');
      const previewResponse = await get(preview, { ticket: previewTicket });
      assert.equal(previewResponse.status, 200);
      assert.equal(
        previewResponse.body.toString(),
        serializeManagedFileReadPreview(fileId, {
          text: baseline.text,
          structure: baseline.structure,
        }),
      );
      assert.equal(Number(previewResponse.headers['content-length']), previewResponse.body.length);
      await delta(2);
      assert.equal(storageRequests.length, 2);
      report.phases.push(
        'same-ticket replay and inspection do not extend; explicit preview extends once without S3',
      );

      const priorRequests = storageRequests.length;
      assert.equal((await get(preparation(other), { identity: other })).status, 404);
      assert.equal((await get(original, { identity: other, ticket })).status, 404);
      const changedReceipt = await admit();
      await runAsSystem(() =>
        db.models.UploadOperation.updateOne(
          { _id: fileId },
          { $set: { 'original.versionId': 'changed-version' } },
        ),
      );
      assert.equal((await get(original, { ticket: changedReceipt })).status, 404);
      await runAsSystem(() =>
        db.models.UploadOperation.updateOne(
          { _id: fileId },
          { $set: { 'original.versionId': receipt.versionId } },
        ),
      );
      const changedFile = await admit();
      await runAsSystem(() =>
        db.models.File.updateOne({ file_id: fileId }, { $set: { bytes: payload.length + 1 } }),
      );
      assert.equal((await get(original, { ticket: changedFile })).status, 404);
      await runAsSystem(() =>
        db.models.File.updateOne({ file_id: fileId }, { $set: { bytes: payload.length } }),
      );
      await delta(2);
      assert.equal(storageRequests.length, priorRequests);
      report.phases.push(
        'foreign owner, changed durable original receipt and changed current File denied before storage',
      );

      const abortTicket = await admit();
      nextStorageMode = 'held';
      activeTail = undefined;
      const partial = request(original, {
        ticket: abortTicket,
        onChunk: (_chunk, req) => req.destroy(new Error('Intentional fixture client abort')),
      });
      await assert.rejects(partial.result);
      await until(() => storageResponses.size === 0);
      activeTail?.resolve();
      await delta(2);
      const corruptTicket = await admit();
      nextStorageMode = 'corrupt';
      const corrupt = await get(original, { ticket: corruptTicket });
      assert.equal(corrupt.status, 503);
      assert.deepEqual(JSON.parse(corrupt.body), { code: 'unavailable' });
      const final = await delta(2);
      assert.equal(completionCommits.length, 2);
      assert.equal(final.receipts, 6);
      assert.ok(
        storageRequests.every(
          (entry) =>
            entry.method === 'GET' && entry.signed && entry.versionId === receipt.versionId,
        ),
      );
      report.phases.push(
        'client abort and corrupted object bytes do not complete or extend; no replacement read identity',
      );
      report.result = 'passed';
      report.final = final;
      report.storageRequests = storageRequests;
      report.completionCommits = completionCommits;
      report.originalTerminal = terminal;
    } finally {
      await settleFixture();
    }
  },
);
