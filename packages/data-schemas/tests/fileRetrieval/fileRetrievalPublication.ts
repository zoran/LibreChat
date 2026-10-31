/** Actual Upload acceptance supplies File activity, original custody and job projections for publication. */
import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { UploadPrincipal } from 'librechat-data-provider';
import {
  uploadSecurityFixture,
  bindUploadOriginalFixture,
} from '../../specs/fixtures/uploadManagement.security.fixture';
import fixture from '../../../data-provider/src/__fixtures__/managed-retrieval-v1.json';
import { createUploadManagementRepository } from '../../src/methods/uploadManagement';
import { createModels } from '../../src/models';

export interface FileRetrievalPublicationFixture {
  db: mongoose.Mongoose;
  principal: UploadPrincipal;
  repository: ReturnType<typeof createUploadManagementRepository>;
  close(): Promise<void>;
}

export async function acceptedRetrievalPublication(
  now: number,
): Promise<FileRetrievalPublicationFixture> {
  const db = mongoose;
  const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const close = async (): Promise<void> => {
    try {
      await db.disconnect();
    } finally {
      await mongo.stop();
    }
  };
  const principal: UploadPrincipal = {
    ...fixture.revisionInput.owner,
    userId: '507f1f77bcf86cd799439011',
    authentication: 'verified-email',
  };
  try {
    await db.connect(mongo.getUri('retrieval_publication'));
    createModels(db);
    await Promise.all([db.models.File.init(), db.models.User.init()]);
    await db.models.User.create({
      _id: principal.userId,
      tenantId: principal.tenantId,
      email: 'retrieval-publication@example.invalid',
      emailVerified: true,
    });
    const repository = createUploadManagementRepository(db, {
      enabled: true,
      reconciled: true,
      securityPolicySha256: fixture.revisionInput.approval.policySha256,
      extractionPolicySha256: fixture.revisionInput.extractionPolicySha256,
      baseline: { originalBytes: 0, objectBytes: 0, textBytes: 0, recordBytes: 0, bundles: 0 },
    });
    await repository.initialize();
    const fileId = fixture.revisionInput.fileId;
    const { bytes, mediaType, sha256 } = fixture.revisionInput.document.structure.source;
    await repository.reserve(
      principal,
      {
        operationId: fileId,
        idempotencyKey: randomUUID(),
        mediaType,
        declaredBytes: bytes,
        fingerprint: JSON.stringify([{ kind: 'personal' }, mediaType, bytes]),
      },
      now,
    );
    const lease = await repository.claim({
      kind: 'transfer',
      principal,
      operationId: fileId,
      worker: { hostId: 'fixture-host', instanceId: 'fixture-intake' },
      now,
    });
    if (!lease) throw new Error('Actual retrieval fixture transfer was not admitted');
    const receipt = {
      outcome: 'durable' as const,
      bytes,
      source: 's3',
      filepath: `/api/files/download/${fileId}`,
      storageKey: `t/${principal.tenantId}/managed-uploads/${principal.userId}/${fileId}.${lease.generation}__original`,
      integrity: {
        version: 1 as const,
        algorithm: 'sha256' as const,
        sha256,
        chunkBytes: 262144 as const,
        chunkSha256: [sha256],
      },
    };
    // This inert external-engine tuple exercises current validators, not physical AV acceptance.
    const security = uploadSecurityFixture(
      {
        ...fixture.revisionInput.approval,
        decision: 'approved',
        subject: {
          ...fixture.revisionInput.approval.subject,
          userId: principal.userId,
          transferGeneration: lease.generation,
        },
        checkedAt: new Date(now).toISOString(),
        coverage: { ...fixture.revisionInput.approval.coverage, complete: true },
      },
      {
        attemptId: `${fileId}.${lease.generation}`,
        instanceId: randomUUID(),
        executionId: randomUUID(),
        expiresAt: new Date(now + 60_000).toISOString(),
      },
    );
    const { approval, execution, settlement } = security;
    await repository.bindSecurityExecution(lease, execution, now);
    await repository.settleSecurityExecution(lease, settlement, now);
    await bindUploadOriginalFixture(repository, lease, receipt, approval, now);
    const worker = { hostId: 'fixture-host', instanceId: 'fixture-app' };
    const promotionId = randomUUID();
    await repository.preparePromotion(
      {
        version: 1,
        promotionId,
        lease,
        worker,
        approval,
        integrity: receipt.integrity,
        metadata: { filename: 'source.txt' },
      },
      now,
    );
    await repository.beginPromotion(lease, promotionId, worker, now);
    await repository.settlePromotion(
      {
        operationId: fileId,
        transferGeneration: lease.generation,
        promotionId,
        worker,
        writerStopped: true,
        receipt,
      },
      now,
    );
    await repository.accept(principal, lease, receipt, approval, { filename: 'source.txt' }, now);
    await repository.confirmCleanup(
      {
        operationId: fileId,
        generation: lease.generation,
        writerStopped: true,
        localCopiesAbsent: true,
        originalAbsent: false,
        textAndHistoryRemoved: false,
      },
      now,
    );
    return { db, principal, repository, close };
  } catch (error) {
    await close();
    throw error;
  }
}
