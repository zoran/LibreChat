/** Real raw/Mongo/mTLS/thread flow. Ordinary storage alone is a local-byte test double, not S3. */
import path from 'node:path';
import mongoose from 'mongoose';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { UPLOAD_RETENTION_MS, readUploadOriginalWriteBinding } from 'librechat-data-provider';
import type {
  UploadDerivedOrigin,
  UploadSecurityApproval,
  UploadSecurityInspection,
  UploadSecurityExecution,
} from 'librechat-data-provider';
import type { UploadSecurityScopeReceipt } from 'librechat-data-provider';
import type { IMongoFile } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { StoragePort, UploadSecurityPort } from '../contract';
import type { SecurityPdfOcrProvider } from './pdf-ocr';
import { createInertAntivirusFixture } from './antivirus-fixture.helper';
import { extractManagedDocument } from '~/files/documents/managed';
import { createSecurityFlowFixture } from './flow-fixture.helper';
import { createRawUploadBodyHandler } from '../transport/body';
import { observeSecurityProcess } from './process-observer';
import { startSecurityService } from './service';
import { createSecurityWorker } from './worker';
describe('assembled scanner admission with real Mongo, mTLS and worker thread', () => {
  const fixture = createSecurityFlowFixture();
  it.each(['approved', 'lost-bind-ack', 'unknown-retirement'])(
    'keeps native PDF %s behind original Mongo binding and full scope retirement',
    async (mode) => {
      const bytes = fixture.document();
      const operation = await fixture.management.reserve(fixture.principal, {
        idempotencyKey: randomUUID(),
        mediaType: 'application/pdf',
        declaredBytes: bytes.length,
      });
      let execution: UploadSecurityExecution | undefined;
      let pages = 0;
      let retired = mode !== 'unknown-retirement';
      const receipt = (): UploadSecurityScopeReceipt | null =>
        execution?.custody.kind === 'pdf-ocr' && retired
          ? {
              version: 1,
              scope: execution.custody.scope,
              state: 'retired',
              writerStopped: true,
              transientDataRemoved: true,
              dispatchedPages: Array.from({ length: pages }, (_, index) => index + 1),
            }
          : null;
      const provider: SecurityPdfOcrProvider = {
        async prepare(input) {
          expect(
            await fixture.observer.models.UploadOperation.findById(operation.id).lean(),
          ).not.toHaveProperty('securityExecution');
          execution = {
            ...input.execution,
            custody: {
              kind: 'pdf-ocr',
              scope: {
                version: 1,
                scopeId: 'scope-fixture',
                attemptId: input.execution.attemptId,
                scannerInstanceId: input.execution.instanceId,
                scannerExecutionId: input.execution.executionId,
                expiresAt: input.execution.expiresAt,
                documentSha256: input.subject.sha256,
                pageLimit: 32,
                requestIdScheme: 'cortex-ocr-page-sha256-v1',
                workDeadline: input.workDeadline,
                cleanupDeadline: input.cleanupDeadline,
                providerBinding: {
                  podUid: 'pod-fixture',
                  containerId: 'a'.repeat(64),
                  runtimeImage: 'registry.invalid/ocr@sha256:' + 'b'.repeat(64),
                  sourceManifestSha256: 'c'.repeat(64),
                  modelRevision: 'aaa02f3811945a91062062994c5c4a3f4c0af2b0',
                  profileSha256: 'd'.repeat(64),
                  apiIncarnation: 'api-fixture',
                  engineIncarnation: 'engine-fixture',
                  workerIncarnation: 'worker-fixture',
                },
              },
            },
          };
          return execution;
        },
        open: () => ({
          async readPage() {
            const row = await fixture.observer.models.UploadOperation.findById(operation.id).lean();
            expect(row).toMatchObject({ securityExecution: execution });
            expect(row).not.toHaveProperty('original');
            expect(
              await fixture.observer.models.File.countDocuments({ file_id: operation.id }),
            ).toBe(0);
            pages++;
            return { complete: true, readable: true, text: 'Synthetic readable text' };
          },
          close: async () => receipt(),
          cancel: async () => receipt(),
          localCopiesRemoved: () => true,
        }),
      };
      const launcher = {
        run: jest.fn(
          async (
            input: Parameters<
              NonNullable<Parameters<typeof createSecurityWorker>[0]['pdf']>['launcher']['run']
            >[0],
          ) => {
            const child = spawn(
              process.execPath,
              [path.resolve(__dirname, '../../../dist/uploads/security/pdf-child.cjs')],
              {
                stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
                env: { NODE_ENV: 'test' },
              },
            );
            const joined = new Promise<void>((resolve) => child.once('close', () => resolve()));
            try {
              return await observeSecurityProcess({ child, ...input });
            } finally {
              if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
              await joined;
            }
          },
        ),
      };
      const scanner = createSecurityWorker({
        antivirus: createInertAntivirusFixture().runtime,
        instanceId: randomUUID(),
        policy: JSON.parse(fixture.policyBytes.toString()),
        policySha256: fixture.policySha256,
        threadPath: fixture.serviceOptions.threadPath,
        pdf: { provider, launcher },
      });
      const bind = fixture.repository.bindSecurityExecution.bind(fixture.repository);
      const lost =
        mode === 'lost-bind-ack'
          ? jest
              .spyOn(fixture.repository, 'bindSecurityExecution')
              .mockImplementationOnce(async (...args) => {
                await bind(...args);
                throw new Error('fixture-lost-bind-ack');
              })
          : undefined;
      try {
        const result = await fixture.ingestDerivedFlow(operation.id, bytes, scanner);
        const row = await fixture.observer.models.UploadOperation.findById(operation.id).lean();
        expect(row).toMatchObject({ securityExecution: execution });
        if (mode === 'approved') {
          expect(result.response.statusCode).toBe(202);
          expect(result.put).toHaveBeenCalledTimes(1);
          expect(row).toMatchObject({
            securitySettlement: { providerReceipt: { state: 'retired', dispatchedPages: [1] } },
          });
          expect(pages).toBe(1);
        } else {
          expect(result.response.statusCode).toBe(422);
          expect(result.put).not.toHaveBeenCalled();
          expect(await fixture.observer.models.File.countDocuments({ file_id: operation.id })).toBe(
            0,
          );
          if (mode === 'lost-bind-ack') {
            expect(pages).toBe(0);
            expect(launcher.run).not.toHaveBeenCalled();
          } else {
            expect(row).not.toHaveProperty('securitySettlement');
            expect(row).toMatchObject({ stagingHeld: true });
          }
        }
      } finally {
        lost?.mockRestore();
        retired = true;
        expect((await scanner.close(AbortSignal.timeout(5000))).complete).toBe(true);
      }
    },
  );
  async function publishDerivedFlow(id: string) {
    const lease = await fixture.management.claimProcessing(fixture.worker);
    expect(lease?.operationId).toBe(id);
    const input = await fixture.management.getProcessingInput(lease!);
    expect(input.securityApproval.subject.operationId).toBe(id);
    // This receipt represents the joined in-process extractor below, not an isolated parser job.
    await fixture.management.bindProcessingExecution(lease!, {
      attemptId: `${id}.${lease!.generation}`,
      instanceId: 'flow-inline-extractor',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    const { text, structure } = await extractManagedDocument({
      filePath: path.join(fixture.ordinaryRoot, id),
      mediaType: 'text/plain',
    });
    await fixture.management.publish(lease!, { text, structure, writerStopped: true });
    await fixture.management.confirmCleanup({
      operationId: id,
      generation: lease!.generation,
      writerStopped: true,
      localCopiesAbsent: true,
      originalAbsent: false,
      textAndHistoryRemoved: false,
    });
    return fixture.management.get(fixture.principal, id);
  }
  it.each(['approved', 'marked'] as const)(
    'keeps native derived %s bytes behind the same real scanner and source lifecycle',
    async (decision) => {
      const sourceBytes = Buffer.from('Unmarkierter Quellentext für den abgeleiteten Entwurf.');
      const source = await fixture.management.reserve(fixture.principal, {
        idempotencyKey: randomUUID(),
        mediaType: 'text/plain',
        declaredBytes: sourceBytes.length,
      });
      const uploadedSource = await fixture.ingestDerivedFlow(source.id, sourceBytes);
      expect(uploadedSource.response.statusCode).toBe(202);
      const readySource = await publishDerivedFlow(source.id);
      expect(readySource).toMatchObject({ state: 'ready', canUseInComposer: true });
      const sourceFile = await fixture.observer.models.File.findOne({ file_id: source.id })
        .select('+securityApproval')
        .lean<IMongoFile>();
      expect(sourceFile).toMatchObject({ status: 'ready', text: sourceBytes.toString('utf8') });
      const bytes = Buffer.from(
        decision === 'marked'
          ? 'Einstufung: VS-VERTRAULICH\nNeu erzeugter Entwurf.'
          : 'Abgeleiteter Entwurf aus einer freigegebenen Quelle.',
      );
      const derived = await fixture.management.reserveDerived(fixture.principal, {
        idempotencyKey: randomUUID(),
        mediaType: 'text/plain',
        declaredBytes: bytes.length,
        derived: {
          binding: { purpose: 'workspace-draft', sourceId: 'flow-draft', sourceRevision: 1 },
          directSourceFileIds: [source.id],
        },
      });
      const captured = await fixture.observer.models.UploadOperation.findById(derived.id).lean<{
        derivedOrigin?: UploadDerivedOrigin;
      }>();
      expect(captured?.derivedOrigin).toMatchObject({
        version: 2,
        directSourceFileIds: [source.id],
        ancestors: [
          {
            subject: sourceFile!.securityApproval!.subject,
            policySha256: fixture.policySha256,
            sourceBindingSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            expiresAt: Date.parse(readySource.expiresAt!),
          },
        ],
      });
      const received = await fixture.ingestDerivedFlow(derived.id, bytes);
      const stored = await fixture.observer.models.UploadOperation.findById(derived.id).lean<{
        securityApproval?: UploadSecurityApproval;
      }>();
      expect(stored).toMatchObject({
        derivedOrigin: captured!.derivedOrigin,
        securitySettlement: { writerStopped: true, transientDataRemoved: true },
        stagingHeld: false,
        // Scanner/local cleanup does not consume the durable storage cleanup receipt.
        cleanupPending: decision === 'marked',
      });
      if (decision === 'marked') {
        expect(received.response.statusCode).toBe(422);
        expect(received.response.value).toEqual({ code: 'security_rejected' });
        expect(received.put).not.toHaveBeenCalled();
        expect(stored).not.toHaveProperty('securityApproval');
        expect(stored).not.toHaveProperty('original');
        expect(await fixture.observer.models.File.findOne({ file_id: derived.id })).toBeNull();
        expect(await readdir(fixture.ordinaryRoot)).toEqual([source.id]);
        expect(await fixture.management.claimProcessing(fixture.worker)).toBeNull();
      } else {
        expect(received.response.statusCode).toBe(202);
        expect(received.put).toHaveBeenCalledTimes(1);
        expect(await readFile(path.join(fixture.ordinaryRoot, derived.id))).toEqual(bytes);
        expect(stored?.securityApproval).toMatchObject({
          scannerVersion: 'complete-content-v4',
          subject: {
            operationId: derived.id,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          },
        });
        const ready = await publishDerivedFlow(derived.id);
        expect(ready).toMatchObject({
          state: 'ready',
          canUseInComposer: false,
          expiresAt: new Date(Date.parse(ready.acceptedAt!) + UPLOAD_RETENTION_MS).toISOString(),
        });
        expect(Date.parse(readySource.expiresAt!)).toBeGreaterThan(Date.parse(ready.expiresAt!));
        const file = await fixture.observer.models.File.findOne({ file_id: derived.id })
          .select('+derivedOrigin')
          .lean();
        expect(file).toMatchObject({
          status: 'ready',
          text: bytes.toString('utf8'),
          derivedOrigin: captured!.derivedOrigin,
          expiredAt: new Date(ready.expiresAt!),
        });
        expect(
          await fixture.observer.models.File.findOne({ file_id: derived.id }).lean(),
        ).not.toHaveProperty('derivedOrigin');
      }
      const publicOperations = await fixture.management.list(fixture.principal);
      for (const operation of publicOperations) {
        expect(operation).not.toHaveProperty('derivedOrigin');
        expect(operation).not.toHaveProperty('securityApproval');
      }
      expect(await fixture.management.get(fixture.principal, source.id)).toEqual(readySource);
      expect(await readFile(path.join(fixture.ordinaryRoot, source.id))).toEqual(sourceBytes);
      expect(
        await fixture.observer.models.File.findOne({ file_id: source.id })
          .select('+securityApproval')
          .lean(),
      ).toMatchObject({
        status: 'ready',
        securityApproval: sourceFile!.securityApproval,
        text: sourceBytes.toString('utf8'),
        expiredAt: sourceFile!.expiredAt,
      });
    },
    30000,
  );
  it('rejects a policy hash that does not bind the actual policy bytes', async () => {
    await expect(
      startSecurityService({ ...fixture.serviceOptions, policySha256: '0'.repeat(64) }).then(
        async (unexpected) => {
          await unexpected.close();
          return unexpected;
        },
      ),
    ).rejects.toThrow('Security policy unavailable');
  });
  it('rejects correctly hashed policy bytes that omit the required markings', async () => {
    const incomplete = Buffer.from(JSON.stringify({ version: 1, markings: ['SYNTHETIC'] }));
    await expect(
      startSecurityService({
        ...fixture.serviceOptions,
        policyBytes: incomplete,
        policySha256: createHash('sha256').update(incomplete).digest('hex'),
      }).then(async (unexpected) => {
        await unexpected.close();
        return unexpected;
      }),
    ).rejects.toThrow('Required security markings unavailable');
  });
  it.each([
    ['allowed', Buffer.from('Freigegebener Text mit überprüfbarem Inhalt.'), undefined],
    ['marked', Buffer.from('Einstufung: VS-VERTRAULICH'), 'security_rejected'],
    ['invalid-utf8', Buffer.from([0xc3, 0x28]), 'security_uninspectable'],
  ] as const)(
    'runs %s bytes through the real scanner before ordinary storage',
    async (name, bytes, rejection) => {
      const filename = `Cortex-TEST-Privat-Grüße-${name}.txt`;
      const operation = await fixture.management.reserve(fixture.principal, {
        idempotencyKey: randomUUID(),
        mediaType: 'text/plain',
        declaredBytes: bytes.length,
      });
      const originalSha256 = createHash('sha256').update(bytes).digest('hex');
      const observedInspections: UploadSecurityInspection[] = [];
      const bindings: {
        execution: UploadSecurityExecution;
        stored: unknown;
      }[] = [];
      const storageStates: {
        stored: unknown;
        files: number;
      }[] = [];
      const readOperation = () =>
        fixture.observer.models.UploadOperation.findById(operation.id).lean();
      expect(await readOperation()).not.toHaveProperty('filename');
      expect(JSON.stringify(await readOperation())).not.toContain('Cortex-TEST-Privat');
      expect(JSON.stringify(await fixture.management.list(fixture.principal))).not.toContain(
        'Cortex-TEST-Privat',
      );
      const security: UploadSecurityPort = {
        policySha256: fixture.port.policySha256,
        prepare: (input) => fixture.port.prepare(input),
        cancel: (input) => fixture.port.cancel(input),
        async inspect(input) {
          const binding = { execution: input.execution, stored: await readOperation() };
          bindings.push(binding);
          expect(binding.stored).not.toHaveProperty('filename');
          expect(JSON.stringify(binding.stored)).not.toContain('Cortex-TEST-Privat');
          const result = await fixture.port.inspect(input);
          observedInspections.push(result);
          return result;
        },
      };
      const ordinaryPath = path.join(fixture.ordinaryRoot, operation.id);
      // S3-compatible receipt shape only; the ordinary byte effect is exclusively this temp file.
      const put = jest.fn(async (input: Parameters<StoragePort['put']>[0]) => {
        storageStates.push({
          stored: await readOperation(),
          files: await fixture.observer.models.File.countDocuments({}),
        });
        expect(input.lease.operationId).toBe(operation.id);
        const storageKey = `t/${input.lease.tenantId}/managed-uploads/${input.lease.userId}/${input.lease.operationId}.${input.lease.generation}__original`;
        const proposal = {
          bucket: 'fixture-security-originals',
          key: storageKey,
          operationId: input.lease.operationId,
          generation: String(input.lease.generation),
          bytes: input.bytes,
          wholeSHA256: input.integrity.sha256,
          mediaType: input.mediaType,
        };
        // Match the real S3 adapter: persist the exact original before consuming body bytes.
        expect(typeof input.bindWrite).toBe('function');
        const binding = { ...(await input.bindWrite(proposal)) };
        expect(readUploadOriginalWriteBinding(binding)).toEqual(binding);
        expect(binding).toEqual({
          version: 1,
          ...proposal,
          originalDeadline: binding.originalDeadline,
        });
        expect(Date.parse(binding.originalDeadline)).toBeGreaterThan(Date.now());
        const persisted = await fixture.observer.models.UploadOperation.findById(
          operation.id,
        ).lean<{ writeBinding?: unknown }>();
        expect(persisted).toHaveProperty('writeBinding');
        expect(readUploadOriginalWriteBinding(Object.assign({}, persisted?.writeBinding))).toEqual(
          binding,
        );
        const chunks: Buffer[] = [];
        for await (const chunk of input.body) {
          input.signal.throwIfAborted();
          chunks.push(Buffer.from(chunk));
        }
        await writeFile(ordinaryPath, Buffer.concat(chunks), { flag: 'wx', mode: 0o600 });
        return {
          outcome: 'durable' as const,
          source: 's3',
          bytes: input.bytes,
          integrity: input.integrity,
          filepath: `/api/files/download/${operation.id}`,
          storageKey,
        };
      });
      const storage: StoragePort = {
        async observeOriginal() {
          throw new Error('Unexpected original status in scanner admission');
        },
        put,
        describeDeletion() {
          throw new Error('Unexpected housekeeping deletion in scanner admission');
        },
        async acknowledgeDeletionConsumed() {
          throw new Error('Unexpected housekeeping deletion in scanner admission');
        },
        async beginDeletion() {
          throw new Error('Unexpected housekeeping deletion in scanner admission');
        },
        async observeDeletion() {
          throw new Error('Unexpected housekeeping deletion in scanner admission');
        },
        async *read() {
          yield await readFile(ordinaryPath);
        },
        async remove() {
          await rm(ordinaryPath, { force: true });
          return 'absent';
        },
      };
      const request = Object.assign(new PassThrough(), {
        params: { id: operation.id },
        body: undefined,
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(bytes.length),
          'x-upload-filename': encodeURIComponent(filename),
        },
      });
      const response = Object.assign(new EventEmitter(), {
        writableEnded: false,
        destroyed: false,
        headersSent: false,
        statusCode: 0,
        value: undefined as unknown,
        setHeader() {},
        status(code: number) {
          this.statusCode = code;
          return this;
        },
        json(value: unknown) {
          this.value = value;
          this.headersSent = true;
          this.writableEnded = true;
          return this;
        },
      });
      const handler = createRawUploadBodyHandler({
        management: fixture.management,
        principal: async () => fixture.principal,
        storage,
        security,
        worker: fixture.worker,
        stagingRoot: fixture.stagingRoot,
        claimBytes: fixture.management.claimWorkBytes,
        completeBytes: fixture.management.completeWorkBytes,
        deadlineMs: 15000,
      });
      const done = handler(
        request as unknown as Request,
        response as unknown as Response,
        (error) => {
          if (error) throw error;
        },
      );
      request.end(bytes);
      await done;
      expect(bindings).toHaveLength(1);
      expect(bindings[0].stored).toMatchObject({
        state: 'transferring',
        securityExecution: bindings[0].execution,
      });
      expect(bindings[0].stored).not.toHaveProperty('securitySettlement');
      expect(observedInspections).toHaveLength(1);
      const stored = await readOperation();
      expect(stored).toMatchObject({
        securityExecution: bindings[0].execution,
        securitySettlement: {
          execution: bindings[0].execution,
          writerStopped: true,
          transientDataRemoved: true,
        },
        stagingHeld: false,
        // Rejected attempts remain owned by durable housekeeping after local cleanup.
        cleanupPending: rejection !== undefined,
      });
      expect(await readdir(fixture.stagingRoot)).toEqual([]);
      await expect(
        fixture.management.get(
          { ...fixture.principal, userId: new mongoose.Types.ObjectId().toString() },
          operation.id,
        ),
      ).rejects.toMatchObject({ code: 'forbidden' });
      if (rejection) {
        expect(response.statusCode).toBe(422);
        expect(response.value).toEqual({ code: rejection });
        expect(observedInspections[0].decision).toMatchObject({
          decision: rejection === 'security_rejected' ? 'rejected' : 'uninspectable',
        });
        expect(put).not.toHaveBeenCalled();
        expect(await readdir(fixture.ordinaryRoot)).toEqual([]);
        expect(await fixture.observer.models.File.countDocuments({})).toBe(0);
        expect(stored).not.toHaveProperty('securityApproval');
        expect(stored).not.toHaveProperty('filename');
        expect(JSON.stringify(stored)).not.toContain('Cortex-TEST-Privat');
        expect(JSON.stringify(await fixture.management.list(fixture.principal))).not.toContain(
          'Cortex-TEST-Privat',
        );
        expect(await fixture.management.claimProcessing(fixture.worker)).toBeNull();
        expect(await fixture.management.usage(fixture.principal)).toMatchObject({
          usedBytes: 0,
          retainedBytes: 0,
          reservedBytes: 0,
        });
      } else {
        expect(response.statusCode).toBe(202);
        expect(response.value).toMatchObject({ id: operation.id, state: 'queued_processing' });
        expect(put).toHaveBeenCalledTimes(1);
        expect(put.mock.calls[0][0].filename).toBe(filename);
        expect(storageStates[0].stored).not.toHaveProperty('filename');
        expect(storageStates[0]).toMatchObject({
          files: 0,
          stored: {
            state: 'transferring',
            securityExecution: bindings[0].execution,
            securitySettlement: {
              execution: bindings[0].execution,
              writerStopped: true,
              transientDataRemoved: true,
            },
          },
        });
        expect(await readFile(ordinaryPath)).toEqual(bytes);
        const approved = observedInspections[0].decision;
        expect(approved).toMatchObject({
          decision: 'approved',
          policySha256: fixture.policySha256,
          scannerVersion: 'complete-content-v4',
          subject: {
            tenantId: fixture.principal.tenantId,
            userId: fixture.principal.userId,
            operationId: operation.id,
            transferGeneration: 1,
            mediaType: 'text/plain',
            bytes: bytes.length,
            sha256: originalSha256,
          },
        });
        expect(stored).toMatchObject({
          state: 'queued_processing',
          securityApproval: approved,
          filename,
        });
        const file = await fixture.observer.models.File.findOne({ file_id: operation.id })
          .select('+securityApproval')
          .lean();
        expect(file).toMatchObject({ status: 'pending', securityApproval: approved, filename });
        expect(await fixture.management.usage(fixture.principal)).toMatchObject({
          usedBytes: bytes.length,
          retainedBytes: bytes.length,
          reservedBytes: 0,
        });
        const parserLease = await fixture.management.claimProcessing(fixture.worker);
        expect(parserLease?.generation).toBe(2);
        expect(
          (await fixture.management.getProcessingInput(parserLease!)).securityApproval,
        ).toEqual(approved);
        // No parser starts in this suite; release its admitted resources through the real owner.
        await fixture.management.fail(parserLease!, 'processing_failed');
        await fixture.management.confirmCleanup({
          operationId: operation.id,
          generation: parserLease!.generation,
          writerStopped: true,
          localCopiesAbsent: true,
          originalAbsent: false,
          textAndHistoryRemoved: true,
        });
      }
    },
    30000,
  );
});
