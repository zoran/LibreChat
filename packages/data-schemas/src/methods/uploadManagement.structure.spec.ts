/** Real Mongo publication, accounting and cleanup of one private original-bound derivation. */
import mongoose from 'mongoose';
import { createHash } from 'node:crypto';
import { UPLOAD_MAX_TEXT_BYTES, canonicalManagedJson } from 'librechat-data-provider';
import type { StoredUpload, CounterRow } from './uploadManagementStore';
import type { IMongoFile } from '../types/file';
import {
  useUploadStructureFixture,
  copyFrozenUploadFiles,
  completeAcceptedUploadFileCleanup,
} from '../../specs/fixtures/uploadManagement.structure.fixture';
import { uploadSecuritySettlementFixture } from '../../specs/fixtures/uploadManagement.security.fixture';
import { createUploadStore, hasValidUploadPublicationTime } from './uploadManagementStore';
import { createUploadActivationMethods } from './uploadManagementActivation';
import { captureManagedRetrievalInventoryEvidence } from './fileRetrieval';
import { projectFileHousekeeping } from './fileHousekeepingProjection';
import { validFileRetentionActivity } from './fileActivityTransition';
import { createUploadManagementRepository } from './uploadManagement';
import { createFileRetentionMethods } from './fileRetention';
import { createFileMethods } from './file';
import { createModels } from '~/models';
describe('original-bound managed document structure', () => {
  const fixture = useUploadStructureFixture();
  const { db, user, now, policy, sha256, result, localGone, raw, processing } = fixture;
  it('commits text and private structure together and charges both exactly once', async () => {
    const lease = await processing();
    const document = result('Ünicode 😀');
    const expected =
      Buffer.byteLength(document.text) + Buffer.byteLength(JSON.stringify(document.structure));
    const before = structuredClone(document);
    const ready = await fixture.repository.publish(lease, document, now);
    expect(document).toEqual(before);
    expect(await db.models.UploadOperation.findById('structure').lean()).toMatchObject({
      firstPublishedAtMs: now,
    });
    expect(ready).not.toHaveProperty('firstPublishedAtMs');
    expect(await raw()).toMatchObject({
      text: document.text,
      documentStructure: document.structure,
      status: 'ready',
    });
    expect((await fixture.repository.metrics(now)).textBytes).toBe(expected);
    const second = createUploadManagementRepository(db, { securityPolicySha256: policy });
    expect((await second.publish(lease, document, now + 1)).revision).toBe(ready.revision);
    expect(await db.models.UploadOperation.findById('structure').lean()).toMatchObject({
      firstPublishedAtMs: now,
    });
    expect((await second.metrics(now)).textBytes).toBe(expected);
    expect(await db.models.File.findOne({ file_id: 'structure' }).lean()).not.toHaveProperty(
      'documentStructure',
    );
    const selected = await db.models.File.findOne({ file_id: 'structure' }).select(
      '+documentStructure',
    );
    expect(selected!.toJSON()).not.toHaveProperty('documentStructure');
    expect(selected!.toObject()).not.toHaveProperty('documentStructure');
  });

  it.each(['sha256', 'bytes', 'mediaType'] as const)(
    'rejects other original %s without partial commit',
    async (field) => {
      const lease = await processing();
      const document = result();
      if (field === 'sha256') document.structure.source.sha256 = 'f'.repeat(64);
      if (field === 'bytes') document.structure.source.bytes++;
      if (field === 'mediaType') document.structure.source.mediaType = 'application/pdf';
      await expect(fixture.repository.publish(lease, document, now)).rejects.toMatchObject({
        code: 'processing_failed',
      });
      expect(await raw()).toMatchObject({ status: 'pending' });
      expect(await db.models.UploadOperation.findById('structure').lean()).not.toHaveProperty(
        'firstPublishedAtMs',
      );
      expect(await raw()).not.toHaveProperty('documentStructure');
      expect(await raw()).not.toHaveProperty('text');
      expect((await fixture.repository.metrics(now)).textBytes).toBe(UPLOAD_MAX_TEXT_BYTES);
    },
  );

  it('rolls back File publication and first time when the operation save fails', async () => {
    const lease = await processing();
    const replace = jest
      .spyOn(db.models.UploadOperation, 'replaceOne')
      .mockRejectedValueOnce(new Error('publication save failed'));
    await expect(fixture.repository.publish(lease, result(), now + 100)).rejects.toThrow(
      'publication save failed',
    );
    replace.mockRestore();
    expect(await raw()).toMatchObject({ status: 'pending' });
    expect(await db.models.UploadOperation.findById('structure').lean()).not.toHaveProperty(
      'firstPublishedAtMs',
    );
    await fixture.repository.publish(lease, result(), now + 200);
    expect(await db.models.UploadOperation.findById('structure').lean()).toMatchObject({
      firstPublishedAtMs: now + 200,
    });
  });
  it('keeps old ready rows without a publication time historically unknown on replay', async () => {
    const lease = await processing();
    await fixture.repository.publish(lease, result(), now);
    await (
      db.models.UploadOperation.collection as unknown as mongoose.Collection<StoredUpload>
    ).updateOne({ _id: 'structure' }, { $unset: { firstPublishedAtMs: '' } });
    await fixture.repository.publish(lease, result(), now + 500);
    expect(await db.models.UploadOperation.findById('structure').lean()).not.toHaveProperty(
      'firstPublishedAtMs',
    );
  });
  it.each(['replace', 'remove'])(
    'prevents a later private save from attempting to %s the first publication time',
    async (kind) => {
      const lease = await processing();
      await fixture.repository.publish(lease, result(), now);
      const store = createUploadStore(db, {});
      await expect(
        store.transaction(async (session) => {
          const row = (await store.Operation.findById('structure').session(session).lean())!;
          if (kind === 'replace') row.firstPublishedAtMs = now + 1;
          else delete row.firstPublishedAtMs;
          await store.save(row, session);
        }),
      ).rejects.toMatchObject({ code: 'unavailable' });
      expect(await db.models.UploadOperation.findById('structure').lean()).toMatchObject({
        firstPublishedAtMs: now,
      });
    },
  );

  it('keeps one captured publication clock across an actual transaction retry', async () => {
    const lease = await processing();
    const error = new mongoose.mongo.MongoServerError({ message: 'retry publication', code: 112 });
    error.addErrorLabel('TransientTransactionError');
    const replace = jest
      .spyOn(db.models.UploadOperation, 'replaceOne')
      .mockRejectedValueOnce(error);
    try {
      await fixture.repository.publish(lease, result(), now + 100);
      expect(replace).toHaveBeenCalledTimes(2);
    } finally {
      replace.mockRestore();
    }
    expect(await db.models.UploadOperation.findById('structure').lean()).toMatchObject({
      firstPublishedAtMs: now + 100,
    });
  });
  it.each([
    [false, 'ready'],
    [true, 'ready'],
    [false, 'deleted'],
    [true, 'deleted'],
    [false, 'expired'],
    [true, 'expired'],
  ] as const)(
    'round-trips first publication history with legacy-unknown=%s and state=%s',
    async (legacy, state) => {
      const historyShift = state === 'expired' ? 36 * 86_400_000 : 0;
      const expectedPublicationAt = now + 100 - historyShift;
      const lease = await processing();
      await fixture.repository.publish(lease, result(), now + 100);
      await fixture.repository.confirmCleanup(localGone(lease), now + 101);
      if (state === 'deleted') await fixture.repository.delete(user, 'structure', now + 102);
      if (state === 'expired') {
        // Model an already-published historical fixture, preserving its full relative chronology.
        // Real expiry still requires both application time and Mongo $$NOW; no live guard is mocked.
        const session = await db.startSession();
        try {
          await session.withTransaction(async () => {
            const row = (await db.models.UploadOperation.findById('structure')
              .session(session)
              .lean<StoredUpload>())!;
            const file = (await db.models.File.findOne({ file_id: 'structure' })
              .select(
                '+securityApproval +originalWriteBinding +retentionActivity +retrievalCreation',
              )
              .session(session)
              .lean<IMongoFile>())!;
            if (
              !file.retentionActivity ||
              !file.retentionAcceptedAt ||
              !file.expiredAt ||
              !file.retrievalCreation ||
              !file.securityApproval ||
              row.acceptedAt === undefined ||
              row.expiresAt === undefined ||
              row.firstPublishedAtMs === undefined ||
              !row.securityApproval ||
              !row.securityExecution ||
              !row.securitySettlement ||
              !row.parserExecution ||
              row.securityApproval.version !== 2 ||
              row.securityExecution.version !== 3 ||
              !row.writeBinding ||
              !file.originalWriteBinding
            )
              throw Error('Expected complete published fixture clocks');
            expect(row).toMatchObject({ state: 'ready', stagingHeld: false, writerStopped: true });
            expect(row.slot).toBeUndefined();
            expect(row.leaseExpiresAt).toBeUndefined();
            expect(file.retrievalCreation.state).toBe('empty');
            expect(file.managedRetrieval).toBeUndefined();
            expect(validFileRetentionActivity(file.retentionActivity, file.expiredAt)).toBe(true);
            const date = (value: Date) => new Date(value.getTime() - historyShift);
            const iso = (value: string) => date(new Date(value)).toISOString();
            const antivirus = {
              ...row.securityExecution.antivirus,
              dailyPublishedAt: iso(row.securityExecution.antivirus.dailyPublishedAt),
              expiresAt: iso(row.securityExecution.antivirus.expiresAt),
            };
            const execution = {
              ...row.securityExecution,
              expiresAt: iso(row.securityExecution.expiresAt),
              antivirus,
            };
            const securityApproval = {
              ...row.securityApproval,
              checkedAt: iso(row.securityApproval.checkedAt),
              antivirus: {
                ...row.securityApproval.antivirus,
                custody: antivirus,
                readyObservedAt: iso(row.securityApproval.antivirus.readyObservedAt),
                cleanAt: iso(row.securityApproval.antivirus.cleanAt),
              },
            };
            const aged: StoredUpload = {
              ...row,
              createdAt: row.createdAt - historyShift,
              acceptedAt: row.acceptedAt - historyShift,
              expiresAt: row.expiresAt - historyShift,
              firstPublishedAtMs: row.firstPublishedAtMs - historyShift,
              securityApproval,
              securityExecution: execution,
              securitySettlement: uploadSecuritySettlementFixture(execution),
              writeBinding: {
                ...row.writeBinding,
                originalDeadline: iso(row.writeBinding.originalDeadline),
              },
              parserExecution: {
                ...row.parserExecution,
                expiresAt: iso(row.parserExecution.expiresAt),
              },
            };
            for (const field of ['processingQueuedAt', 'byteLeaseUntil'] as const)
              if (row[field] !== undefined) aged[field] = row[field]! - historyShift;
            const activity = { ...file.retentionActivity };
            for (const field of [
              'baselineDeadlineAt',
              'trackedSince',
              'lastSuccessfulReadAt',
              'lastSuccessfulProcessingAt',
            ] as const)
              if (activity[field] !== undefined) activity[field] = date(activity[field]!);
            const next: IMongoFile = {
              ...file,
              retentionAcceptedAt: date(file.retentionAcceptedAt),
              expiredAt: date(file.expiredAt),
              retentionActivity: activity,
              securityApproval,
              originalWriteBinding: {
                ...file.originalWriteBinding,
                originalDeadline: iso(file.originalWriteBinding.originalDeadline),
              },
              retrievalCreation: {
                ...file.retrievalCreation,
                acceptedAt: file.retrievalCreation.acceptedAt - historyShift,
              },
            };
            for (const field of ['createdAt', 'updatedAt'] as const)
              if (file[field] instanceof Date) next[field] = date(file[field]);
            expect(
              activity.baselineDeadlineAt.getTime() - next.retentionAcceptedAt!.getTime(),
            ).toBe(28 * 86_400_000);
            expect(next.expiredAt!.getTime() - activity.baselineDeadlineAt.getTime()).toBe(
              7 * 86_400_000,
            );
            expect(activity).toMatchObject({
              processingCount: 1,
              readCount: 0,
              deadlineGeneration: 1,
            });
            expect(validFileRetentionActivity(activity, next.expiredAt)).toBe(true);
            expect(hasValidUploadPublicationTime(aged)).toBe(true);
            expect(aged.firstPublishedAtMs).toBe(expectedPublicationAt);
            expect(aged.acceptedAt).toBe(next.retentionAcceptedAt!.getTime());
            expect(aged.expiresAt).toBe(next.expiredAt!.getTime());
            expect(aged.expiresAt).toBeLessThan(Date.now());
            for (const field of [
              'state',
              'original',
              'publishedDigest',
              'originalBytes',
              'textBytes',
              'recordBytes',
            ] as const)
              expect(aged[field]).toEqual(row[field]);
            // Only isolated historical fixture input is translated; owners still perform all transitions.
            await (
              db.models.UploadOperation.collection as unknown as mongoose.Collection<StoredUpload>
            ).replaceOne({ _id: row._id }, aged, { session });
            await db.models.File.collection.updateOne(
              { _id: file._id },
              {
                $set: {
                  retentionAcceptedAt: next.retentionAcceptedAt,
                  expiredAt: next.expiredAt,
                  retentionActivity: next.retentionActivity,
                  securityApproval: next.securityApproval,
                  originalWriteBinding: next.originalWriteBinding,
                  retrievalCreation: next.retrievalCreation,
                  createdAt: next.createdAt,
                  updatedAt: next.updatedAt,
                },
              },
              { session },
            );
            await projectFileHousekeeping(db, file, next, session);
          });
        } finally {
          await session.endSession();
        }
        await fixture.repository.reconcile(Date.now());
      }
      expect(await db.models.UploadOperation.findById('structure').lean()).toMatchObject({ state });
      if (legacy)
        await (
          db.models.UploadOperation.collection as unknown as mongoose.Collection<StoredUpload>
        ).updateOne({ _id: 'structure' }, { $unset: { firstPublishedAtMs: '' } });
      const page = await fixture.repository.exportSnapshot({
        epoch: 'publication-time',
        limit: 100,
      });
      const record = page.records.find((item) => item.type === 'operation')!.value as StoredUpload;
      if (legacy) expect(record).not.toHaveProperty('firstPublishedAtMs');
      else expect(record.firstPublishedAtMs).toBe(expectedPublicationAt);
      const target = new mongoose.Mongoose();
      try {
        await target.connect(fixture.mongo.getUri(`publication-import-${legacy}-${state}`));
        createModels(target);
        const imported = createUploadManagementRepository(target, { securityPolicySha256: policy });
        await imported.initialize();
        await copyFrozenUploadFiles(db, target);
        await imported.importSnapshot(page);
        await imported.importSnapshot(page);
        const stored = await target.models.UploadOperation.findById('structure').lean();
        if (legacy) expect(stored).not.toHaveProperty('firstPublishedAtMs');
        else expect(stored).toMatchObject({ firstPublishedAtMs: expectedPublicationAt });
      } finally {
        await target.disconnect();
      }
    },
  );
  it.each(['before-acceptance', 'after-expiry', 'fractional'])(
    'rejects malformed first publication %s during migration',
    async (kind) => {
      const lease = await processing();
      await fixture.repository.publish(lease, result(), now + 100);
      await fixture.repository.confirmCleanup(localGone(lease), now + 101);
      const row = (await db.models.UploadOperation.findById('structure').lean<
        StoredUpload & Required<Pick<StoredUpload, 'expiresAt'>>
      >())!;
      let firstPublishedAtMs: number;
      if (kind === 'before-acceptance') firstPublishedAtMs = now - 1;
      else if (kind === 'after-expiry') firstPublishedAtMs = row.expiresAt;
      else firstPublishedAtMs = now + 0.5;
      await (
        db.models.UploadOperation.collection as unknown as mongoose.Collection<StoredUpload>
      ).updateOne({ _id: 'structure' }, { $set: { firstPublishedAtMs } });
      await expect(
        fixture.repository.exportSnapshot({ epoch: 'invalid-publication' }),
      ).rejects.toMatchObject({ code: 'migration_conflict' });
    },
  );

  it.each([
    ['queued_processing', false],
    ['failed', false],
    ['queued_processing', true],
    ['failed', true],
  ] as const)(
    'rejects invented %s publication history with forged digest=%s atomically',
    async (state, withDigest) => {
      const lease = await processing();
      await fixture.repository.fail(lease, 'processing_failed', now + 10);
      await fixture.repository.confirmCleanup(localGone(lease), now + 11);
      if (state === 'queued_processing')
        await fixture.repository.retryProcessing(user, 'structure', now + 12);
      const page = await fixture.repository.exportSnapshot({ epoch: 'unpublished-history' });
      const forged = structuredClone(page);
      const record = forged.records.find((item) => item.type === 'operation')!
        .value as StoredUpload;
      expect(record.state).toBe(state);
      expect(record).not.toHaveProperty('firstPublishedAtMs');
      record.firstPublishedAtMs = now + 1;
      if (withDigest) record.publishedDigest = 'd'.repeat(64);
      // Both import and re-export exercise the real shared row validator; no partial import survives.
      const target = new mongoose.Mongoose();
      try {
        await target.connect(fixture.mongo.getUri(`forged-history-${state}-${withDigest}`));
        createModels(target);
        const imported = createUploadManagementRepository(target, { securityPolicySha256: policy });
        await imported.initialize();
        await copyFrozenUploadFiles(db, target);
        await expect(imported.importSnapshot(forged)).rejects.toMatchObject({
          code: 'migration_conflict',
        });
        expect(await target.models.UploadOperation.countDocuments()).toBe(0);
        expect(
          (await target.models.UploadCounter.findById('global').lean<CounterRow>())!.value,
        ).not.toHaveProperty('migration');
        await imported.importSnapshot(page);
        expect(await target.models.UploadOperation.findById('structure').lean()).not.toHaveProperty(
          'firstPublishedAtMs',
        );
      } finally {
        await target.disconnect();
      }
      await (
        db.models.UploadOperation.collection as unknown as mongoose.Collection<StoredUpload>
      ).updateOne(
        { _id: 'structure' },
        {
          $set: {
            firstPublishedAtMs: now + 1,
            ...(withDigest ? { publishedDigest: 'd'.repeat(64) } : {}),
          },
        },
      );
      await expect(
        fixture.repository.exportSnapshot({ epoch: 'unpublished-history' }),
      ).rejects.toMatchObject({ code: 'migration_conflict' });
    },
  );
  it.each(['missing-digest', 'bad-digest', 'missing-parser', 'unfinished-writer'])(
    'rejects present publication time with %s history',
    async (kind) => {
      const lease = await processing();
      await fixture.repository.publish(lease, result(), now + 100);
      await fixture.repository.confirmCleanup(localGone(lease), now + 101);
      let change: mongoose.mongo.UpdateFilter<StoredUpload>;
      if (kind === 'missing-digest') change = { $unset: { publishedDigest: '' } };
      else if (kind === 'bad-digest') change = { $set: { publishedDigest: 'not-a-digest' } };
      else if (kind === 'missing-parser') change = { $unset: { parserExecution: '' } };
      else change = { $set: { writerStopped: false } };
      await (
        db.models.UploadOperation.collection as unknown as mongoose.Collection<StoredUpload>
      ).updateOne({ _id: 'structure' }, change);
      await expect(
        fixture.repository.exportSnapshot({ epoch: 'invalid-history' }),
      ).rejects.toMatchObject({
        code: 'migration_conflict',
      });
    },
  );

  it('retains the first publication time after deletion without exposing it publicly', async () => {
    const lease = await processing();
    await fixture.repository.publish(lease, result(), now + 100);
    await fixture.repository.confirmCleanup(localGone(lease), now + 101);
    const deleted = await fixture.repository.delete(user, 'structure', now + 102);
    expect(deleted).not.toHaveProperty('firstPublishedAtMs');
    expect(await db.models.UploadOperation.findById('structure').lean()).toMatchObject({
      firstPublishedAtMs: now + 100,
    });
  });
  it('refuses to backfill a legacy ready timestamp through the private save owner', async () => {
    const lease = await processing();
    await fixture.repository.publish(lease, result(), now);
    await (
      db.models.UploadOperation.collection as unknown as mongoose.Collection<StoredUpload>
    ).updateOne({ _id: 'structure' }, { $unset: { firstPublishedAtMs: '' } });
    const store = createUploadStore(db, {});
    await expect(
      store.transaction(async (session) => {
        const row = (await store.Operation.findById('structure').session(session).lean())!;
        row.firstPublishedAtMs = now + 1;
        await store.save(row, session);
      }),
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(await db.models.UploadOperation.findById('structure').lean()).not.toHaveProperty(
      'firstPublishedAtMs',
    );
  });

  it('refuses changed structure on retry while canonical object key order remains idempotent', async () => {
    const lease = await processing();
    const document = result();
    await fixture.repository.publish(lease, document, now);
    const reordered = {
      ...document,
      structure: {
        quality: document.structure.quality,
        elements: document.structure.elements,
        pages: [],
        extractor: document.structure.extractor,
        source: document.structure.source,
        version: 1 as const,
      },
    };
    await expect(fixture.repository.publish(lease, reordered, now)).resolves.toMatchObject({
      state: 'ready',
    });
    document.structure.extractor.version = '2';
    await expect(fixture.repository.publish(lease, document, now)).rejects.toMatchObject({
      code: 'lease_lost',
    });
    expect((await raw())!.documentStructure.extractor.version).toBe('1');
  });

  it('includes structure in the existing representation ceiling', async () => {
    const lease = await processing();
    await expect(
      fixture.repository.publish(lease, result('x'.repeat(UPLOAD_MAX_TEXT_BYTES)), now),
    ).rejects.toMatchObject({ code: 'processing_failed' });
    expect(await raw()).not.toHaveProperty('documentStructure');
    expect((await fixture.repository.metrics(now)).textBytes).toBe(UPLOAD_MAX_TEXT_BYTES);
  });

  it('rejects malformed publication and unjoined writers without reading accessors', async () => {
    const lease = await processing();
    const getter = jest.fn(() => result().text);
    const accessor = Object.defineProperty(result(), 'text', { get: getter });
    const invalid = result();
    invalid.structure.elements[0].end++;
    for (const value of [
      accessor,
      invalid,
      { ...result(), writerStopped: false },
      { text: 'legacy', writerStopped: true },
    ]) {
      await expect(fixture.repository.publish(lease, value as never, now)).rejects.toMatchObject({
        code: 'processing_failed',
      });
    }
    expect(getter).not.toHaveBeenCalled();
    expect(await raw()).not.toHaveProperty('documentStructure');
    expect((await fixture.repository.metrics(now)).textBytes).toBe(UPLOAD_MAX_TEXT_BYTES);
  });

  it('also binds the native File publication to its approved original inside the transaction', async () => {
    const lease = await processing();
    const document = result();
    const { text, structure } = document;
    structure.source.sha256 = 'd'.repeat(64);
    const lifecycle = createFileRetentionMethods(db, { securityPolicySha256: policy });
    const session = await db.startSession();
    try {
      await expect(
        session.withTransaction(async () =>
          lifecycle.publishManagedUpload(
            user,
            lease.operationId,
            lease.generation,
            { text, structure },
            now,
            session,
          ),
        ),
      ).rejects.toThrow('Document source unavailable');
    } finally {
      await session.endSession();
    }
    expect(await raw()).not.toHaveProperty('documentStructure');
  });

  it('removes legacy private structure only after inventory reconciliation and cleanup', async () => {
    const lease = await processing();
    await fixture.repository.publish(lease, result(), now);
    await fixture.repository.confirmCleanup(localGone(lease), now);
    const fresh = (await raw())!;
    expect(fresh.retrievalCreation).toEqual({
      version: 1,
      owner: { tenantId: user.tenantId, userId: user.userId },
      fileId: 'structure',
      acceptedAt: now,
      state: 'empty',
    });
    // Represent retained legacy data predating File birth custody. Only this isolated row
    // loses its creation record; fresh production Files retain their known-empty proof.
    const legacy = await db.models.File.collection.updateOne(
      { _id: fresh._id },
      { $unset: { retrievalCreation: '' } },
    );
    expect(legacy.modifiedCount).toBe(1);
    expect(await raw()).not.toHaveProperty('retrievalCreation');
    await fixture.repository.delete(user, 'structure', now);
    const lifecycle = createFileRetentionMethods(db);
    // Unknown legacy inventory must retain original evidence even in this no-indexing fixture.
    expect(await lifecycle.finalizeFileSourceDeletion(user, ['structure'])).toEqual({
      completedFileIds: [],
    });
    expect(await raw()).toHaveProperty('documentStructure');
    const retained = (await raw())!;
    expect(retained.managedRetrieval).toBeUndefined();
    const evidence = captureManagedRetrievalInventoryEvidence(retained);
    const hash = (value: unknown) =>
      createHash('sha256').update(canonicalManagedJson(value)).digest('hex');
    // This isolated fixture has no index dispatch/backend work. Its complete test topology
    // explicitly attests zero obligations; configuration absence is never used as evidence.
    const writer = { writerId: 'structure-fixture-writer', retired: true, pendingWork: 0 };
    const payload = {
      backendIdentity: 'structure-fixture-backend',
      owner: evidence.owner,
      fileId: evidence.fileId,
      evidenceSha256: evidence.evidenceSha256,
      observedAt: now,
      complete: true as const,
      obligations: [],
    };
    const inventoryReceiptSha256 = hash(payload);
    const store = createUploadStore(db, { securityPolicySha256: policy });
    await store.transaction(async (_session, global) => {
      global.enabled = false;
    });
    const snapshot = await fixture.repository.reconciliationSnapshot(now);
    const activation = createUploadActivationMethods(store, {
      retrievalInventoryAuthority: {
        topologySha256: hash({ writers: [writer.writerId], backends: [payload.backendIdentity] }),
        writers: [{ writerId: writer.writerId, retirementReceiptSha256: hash(writer) }],
        backends: [{ backendIdentity: payload.backendIdentity, inventoryReceiptSha256 }],
      },
    });
    await activation.reconcileFileRetrievalInventory(
      {
        reconciliationId: 'structure-fixture-inventory',
        storeId: snapshot.storeId,
        revision: snapshot.revision,
        observedAt: now,
        owner: evidence.owner,
        fileId: evidence.fileId,
        evidenceSha256: evidence.evidenceSha256,
        backends: [{ ...payload, inventoryReceiptSha256 }],
      },
      now,
    );
    expect((await raw())!.managedRetrieval).toMatchObject({
      inventory: 'known',
      obligations: [],
      inventoryReceipt: { evidenceSha256: evidence.evidenceSha256 },
    });
    expect(await lifecycle.prepareFileSourceDeletion(user, ['structure'])).toEqual({
      preparedFileIds: [],
    });
    await completeAcceptedUploadFileCleanup(
      db,
      user,
      'structure',
      fixture.mongo.getUri('document-structure'),
    );
    expect(await lifecycle.prepareFileSourceDeletion(user, ['structure'])).toEqual({
      preparedFileIds: ['structure'],
    });
    await fixture.repository.confirmCleanup(
      { ...localGone(lease), originalAbsent: true, textAndHistoryRemoved: true },
      now,
    );
    expect(await lifecycle.finalizeFileSourceDeletion(user, ['structure'])).toEqual({
      completedFileIds: ['structure'],
    });
    expect(await raw()).not.toHaveProperty('documentStructure');
    expect(await raw()).not.toHaveProperty('text');
    expect((await fixture.repository.metrics(now)).textBytes).toBe(0);
  });

  it('does not admit structure through generic File creation or dotted updates', async () => {
    const files = createFileMethods(db);
    const document = result();
    await files.createFile(
      {
        file_id: 'legacy',
        user: new mongoose.Types.ObjectId(user.userId),
        filename: 'legacy.txt',
        filepath: '/legacy',
        bytes: 8,
        type: 'text/plain',
        text: 'legacy text',
        documentStructure: document.structure,
      },
      true,
    );
    await files.updateFile({
      file_id: 'legacy',
      'documentStructure.source.sha256': sha256,
    } as never);
    const file = await db.models.File.collection.findOne({ file_id: 'legacy' });
    expect(file).not.toHaveProperty('documentStructure');
    expect(file!.text).toBe('legacy text');
  });
});
