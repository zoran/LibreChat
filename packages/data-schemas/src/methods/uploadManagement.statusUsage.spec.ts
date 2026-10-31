/** Real Mongo original publication and Status receipts share the existing upload transaction. */
import mongoose from 'mongoose';
import { readUploadDerivedOrigin } from 'librechat-data-provider';
import type { UploadPrincipal } from 'librechat-data-provider';
import type { UploadPublicationPort } from './uploadManagementTypes';
import { useUploadStructureFixture } from '../../specs/fixtures/uploadManagement.structure.fixture';
import { createUploadManagementRepository } from './uploadManagement';
import { createStatusUsageMethods } from './statusUsage';
describe('original-bound managed status publication', () => {
  const fixture = useUploadStructureFixture();
  const { db, user, now, policy, result, raw, processing } = fixture;
  describe('status publication connection', () => {
    async function bridge() {
      const usage = createStatusUsageMethods(db, {
        scopeId: 'cortex.application.usage.v1',
        tenantId: user.tenantId,
        clock: () => now + 1000,
      });
      await usage.initialize();
      await db.models.StatusUsageReceipt.deleteMany({});
      await db.models.StatusUsageBucket.deleteMany({});
      await usage.initialize();
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- Load the real CommonJS owner at this existing bridge boundary.
      const { createUsageRuntime } = require('../../../../api/server/services/status/usage');
      const runtime = createUsageRuntime({
        mongoose: db,
        policy: { tenantId: user.tenantId },
        createStore: () => usage,
        createCurrent: () => ({}),
      });
      await runtime.initialize();
      const recordOriginalPublication = jest.fn<
        ReturnType<UploadPublicationPort>,
        Parameters<UploadPublicationPort>
      >(runtime.recordOriginalPublication);
      fixture.repository = createUploadManagementRepository(db, {
        securityPolicySha256: policy,
        recordOriginalPublication,
      });
      return { usage, recordOriginalPublication };
    }
    it('joins actual publication, replay and partial history through the existing transaction', async () => {
      const { usage, recordOriginalPublication } = await bridge();
      const lease = await processing();
      await fixture.repository.publish(lease, result(), now);
      await fixture.repository.publish(lease, result(), now + 1);
      expect(recordOriginalPublication).toHaveBeenCalledTimes(1);
      const evidence = await usage.readTrailingHour(Math.ceil((now + 1) / 1000) * 1000);
      expect(evidence).toMatchObject({
        publishedDocuments: 1,
        activeUsers: null,
        complete: false,
        gap: 'not_instrumented',
      });
      expect(
        await db.models.StatusUsageReceipt.countDocuments({ kind: 'document_publication' }),
      ).toBe(1);
    });
    it('rolls back the receipt, bucket, File and immutable time when operation save fails', async () => {
      const { usage, recordOriginalPublication } = await bridge();
      const lease = await processing();
      const save = jest
        .spyOn(db.models.UploadOperation, 'replaceOne')
        .mockRejectedValueOnce(Error('join failed'));
      try {
        await expect(fixture.repository.publish(lease, result(), now)).rejects.toThrow(
          'join failed',
        );
      } finally {
        save.mockRestore();
      }
      expect(recordOriginalPublication).toHaveBeenCalledTimes(1);
      expect(
        await db.models.StatusUsageReceipt.countDocuments({ kind: 'document_publication' }),
      ).toBe(0);
      expect(await raw()).toMatchObject({ status: 'pending' });
      expect(await db.models.UploadOperation.findById('structure').lean()).not.toHaveProperty(
        'firstPublishedAtMs',
      );
      expect(
        (await usage.readTrailingHour(Math.ceil(now / 1000) * 1000)).publishedDocuments,
      ).toBeNull();
    });
    it('commits the upload and marks the gap when receipt capacity is exhausted', async () => {
      const { usage } = await bridge();
      const lease = await processing();
      await db.models.StatusUsageBucket.updateOne(
        { kind: 'control' },
        { $set: { reservedReceipts: 32768 } },
      );
      await fixture.repository.publish(lease, result(), now);
      expect(await raw()).toMatchObject({ status: 'ready' });
      expect(await db.models.StatusUsageReceipt.countDocuments()).toBe(0);
      expect(await usage.readTrailingHour(Math.ceil(now / 1000) * 1000)).toMatchObject({
        complete: false,
        gap: 'capacity',
      });
    });
    it.each(['guest', 'foreign tenant'])(
      'does not count a %s original outside the trusted scope',
      async (kind) => {
        const { usage } = await bridge();
        const userId = new mongoose.Types.ObjectId().toString();
        const principal: UploadPrincipal =
          kind === 'guest'
            ? { userId, tenantId: null, authentication: 'guest' }
            : { userId, tenantId: 'other-tenant', authentication: 'verified-email' };
        await db.models.User.create({
          _id: principal.userId,
          tenantId: principal.tenantId,
          email: 'other@example.test',
          emailVerified: true,
        });
        const lease = await processing(principal);
        await fixture.repository.publish(lease, result(), now);
        expect(await db.models.StatusUsageReceipt.countDocuments()).toBe(0);
        expect(
          (await usage.readTrailingHour(Math.ceil(now / 1000) * 1000)).publishedDocuments,
        ).toBeNull();
      },
    );
    it('does not count a restored derived publication as a new original', async () => {
      const { recordOriginalPublication } = await bridge();
      const lease = await processing();
      // Classification-only restored specimen; no parent or native source hash is invented.
      const origin = readUploadDerivedOrigin({
        version: 2,
        binding: { purpose: 'workspace-draft', sourceId: 'draft', sourceRevision: 1 },
        directSourceFileIds: [],
        ancestors: [],
      });
      if (!origin) throw new Error('Expected supported current empty derived origin');
      await db.models.UploadOperation.updateOne(
        { _id: 'structure' },
        { $set: { derivedOrigin: origin } },
      );
      const file = await raw();
      if (!file?.expiredAt || !file.retentionAcceptedAt)
        throw new Error('Expected actual accepted File dates');
      await db.models.File.collection.updateOne(
        { _id: file._id },
        {
          $set: {
            derivedOrigin: origin,
            derivedRetention: {
              version: 1,
              ownDeadlineAt: file.expiredAt,
              capBasis: 'admission',
              trackedSince: file.retentionAcceptedAt,
              deadlineGeneration: 0,
            },
          },
          $unset: { retentionActivity: '' },
        },
      );
      await fixture.repository.publish(lease, result(), now);
      expect(recordOriginalPublication).not.toHaveBeenCalled();
      expect(await raw()).toMatchObject({ status: 'ready' });
    });
    it('propagates a participating database failure and counts once after transaction retry', async () => {
      const { usage, recordOriginalPublication } = await bridge();
      const lease = await processing();
      const failure = new db.mongo.MongoServerError({
        message: 'retry joined publication',
        code: 112,
      });
      failure.addErrorLabel('TransientTransactionError');
      recordOriginalPublication.mockRejectedValueOnce(failure);
      await fixture.repository.publish(lease, result(), now);
      expect(recordOriginalPublication).toHaveBeenCalledTimes(2);
      expect(
        (await usage.readTrailingHour(Math.ceil((now + 1) / 1000) * 1000)).publishedDocuments,
      ).toBe(1);
    });
  });
});
