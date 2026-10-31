import mongoose from 'mongoose';
import type { ManagedRetrievalState } from 'librechat-data-provider';
import { acceptedRetrievalPublication } from '../../tests/fileRetrieval/fileRetrievalPublication';
import fixture from '../../../data-provider/src/__fixtures__/managed-retrieval-v1.json';
import { createFileRetentionMethods } from './fileRetention';
const now = Date.parse('2026-10-19T10:00:00Z');
it('publishes the trusted private revision through the existing transactional File entry point', async () => {
  const accepted = await acceptedRetrievalPublication(now);
  const session = await accepted.db.startSession();
  const File = accepted.db.models.File;
  const select = jest.spyOn(accepted.db.Query.prototype, 'select');
  const querySession = jest.spyOn(accepted.db.Query.prototype, 'session');
  const updateOne = jest.spyOn(File, 'updateOne');
  const owner = createFileRetentionMethods(accepted.db, {
    securityPolicySha256: fixture.revisionInput.approval.policySha256,
    extractionPolicySha256: fixture.revisionInput.extractionPolicySha256,
  });
  const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
  try {
    await session.withTransaction(async () => {
      await owner.claimManagedUploadProcessing(accepted.principal, 'source-a', 7, now, session);
      await owner.publishManagedUpload(
        accepted.principal,
        'source-a',
        7,
        fixture.revisionInput.document as never,
        now,
        session,
      );
    });
    expect(select).toHaveBeenCalledWith(
      '+securityApproval +managedRetrieval +derivedOrigin +retentionActivity +derivedRetention +retentionRevocationId',
    );
    expect(querySession).toHaveBeenCalledWith(session);
    const calls = updateOne.mock.calls as unknown as Array<
      [
        Record<string, unknown>,
        { $set?: { managedRetrieval?: ManagedRetrievalState; retentionActivity?: unknown } },
        { session?: mongoose.ClientSession },
      ]
    >;
    const call = calls.find(([, update]) => update.$set?.managedRetrieval);
    expect(call).toBeDefined();
    const [filter, update, options] = call!;
    expect(filter.previewRevision).toBe('7');
    expect(update.$set!.managedRetrieval!.revision!.source.transferGeneration).toBe(1);
    // Independent canonical-JSON vectors retain exact revision equality with a valid Mongo principal.
    expect(update.$set!.managedRetrieval!.revision).toEqual({
      ...fixture.revision,
      owner: { tenantId: accepted.principal.tenantId, userId: accepted.principal.userId },
      approvalSha256: '9dab1e0744e388e97d414013a8828ffe457355254df8dc5bfac223f10a8fbdc5',
      sourceRevision: 'e9f0f339a5dbace84b84c19358d3bbe05c6364ace843b6984f5c29ceaaf079f4',
      representationRevision: 'fb6a58cd06ebaae5d2114c2f701cc88e01580b1317441d91fe064ea6d2dd2ece',
    });
    expect(update.$set!.managedRetrieval!.inventory).toBe('unknown');
    expect(options?.session).toBe(session);
    expect(update.$set!.retentionActivity).toMatchObject({
      processingCount: 1,
      deadlineGeneration: 1,
    });
  } finally {
    clock.mockRestore();
    select.mockRestore();
    querySession.mockRestore();
    updateOne.mockRestore();
    await session.endSession();
    await accepted.close();
  }
});
