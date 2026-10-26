import mongoose from 'mongoose';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { canonicalManagedJson } from 'librechat-data-provider';
import type { GenerationJobManagerClass as GenerationManager } from '@librechat/api' with { 'resolution-mode': 'require' };
import type { ManagedRetrievalState } from 'librechat-data-provider';
import { createUploadActivationMethods } from './uploadManagementActivation';
import { createFileRetentionMethods } from './fileRetention';
const {
  createFileDeletionWorkOwner,
}: Pick<
  typeof import('@librechat/api', { with: { 'resolution-mode': 'require' } }),
  'createFileDeletionWorkOwner'
> = jest.requireActual('@librechat/api');
const {
  requestManagedFileDeletion,
}: { requestManagedFileDeletion: (...args: unknown[]) => Promise<unknown> } = jest.requireActual(
  '../../../api/src/files/managedDeletion',
);
import { boundGeneration, boundedAbort } from '../../tests/fileRetrieval/fileRetrievalGeneration';
import { createFileMethods } from './file';
import fileSchema from '../schema/file';
import fixture from '../../../data-provider/src/__fixtures__/managed-retrieval-v1.json';
import {
  prepareManagedRetrievalPublication,
  managedRetrievalDeletionSettled,
  captureManagedRetrievalInventoryEvidence,
  issueManagedRetrievalInventory,
  createManagedFileRetrievalInventory,
  admitManagedFileRetrievalInventory,
  managedFileRetrievalDeletionSettled,
} from './fileRetrieval';

type FixtureFileRow = Record<string, unknown> & {
  managedRetrieval?: Omit<
    ManagedRetrievalState,
    'version' | 'revision' | 'inventory' | 'obligations'
  > & {
    version: number;
    revision: unknown;
    inventory: string;
    obligations: unknown[];
  };
};
const now = Date.parse('2026-10-19T10:00:00Z');
const identity = fixture.revisionInput.owner;
const inventoryAuthority = {
  topologySha256: '1'.repeat(64),
  writers: [{ writerId: 'retired-legacy-rag-writer', retirementReceiptSha256: '2'.repeat(64) }],
  backends: [
    { backendIdentity: fixture.obligation.backendIdentity, inventoryReceiptSha256: '3'.repeat(64) },
  ],
};
const legacyRow = () => ({
  _id: 'row-a',
  file_id: 'source-a',
  user: identity.userId,
  tenantId: identity.tenantId,
  uploadOperationId: 'source-a',
  retentionAcceptedAt: new Date(now - 1000),
  expiredAt: new Date(now + 1000),
  createdAt: new Date(now - 1000),
  deletionRequestedAt: new Date(now),
  retainedDerivativeBytes: 0,
  text: fixture.revisionInput.document.text,
  documentStructure: fixture.revisionInput.document.structure,
  securityApproval: fixture.revisionInput.approval,
});

/** Fresh File birth and first-admission custody are local facts, not backend census fixtures.
 * Protects TXT deletion without retrieval while retaining every legacy/admitted purge guard.
 */
it('keeps fresh File custody empty until its first durable retrieval admission', () => {
  const row = {
    ...legacyRow(),
    retrievalCreation: createManagedFileRetrievalInventory(identity, 'source-a', now - 1000),
  };
  expect(managedRetrievalDeletionSettled(undefined)).toBe(false);
  expect(managedFileRetrievalDeletionSettled(legacyRow())).toBe(false);
  expect(managedFileRetrievalDeletionSettled(row)).toBe(true);

  const published = {
    ...row,
    managedRetrieval: prepareManagedRetrievalPublication(fixture.revisionInput as never)!,
  };
  expect(published.managedRetrieval.inventory).toBe('unknown');
  expect(managedFileRetrievalDeletionSettled(published)).toBe(true);
  const creation = admitManagedFileRetrievalInventory(published)!;
  expect(creation.state).toBe('admitted');
  expect(published.retrievalCreation.state).toBe('empty');
  const admitted = {
    ...published,
    retrievalCreation: creation,
    managedRetrieval: {
      ...published.managedRetrieval,
      obligations: [{ ...fixture.obligation, state: 'preparing' as const }],
    },
  };
  expect(managedFileRetrievalDeletionSettled(admitted)).toBe(false);
  expect(
    managedFileRetrievalDeletionSettled({
      ...admitted,
      retrievalCreation: row.retrievalCreation,
    }),
  ).toBe(false);
  expect(() =>
    admitManagedFileRetrievalInventory({
      ...admitted,
      retrievalCreation: row.retrievalCreation,
    }),
  ).toThrow();
  const purged = {
    ...admitted,
    managedRetrieval: {
      ...admitted.managedRetrieval,
      obligations: [
        {
          ...fixture.obligation,
          state: 'purged' as const,
          purgeOperationId: fixture.purgeReceipt.purgeOperationId,
          receiptSha256: fixture.purgeReceipt.receiptSha256,
        },
      ],
    },
  };
  expect(managedFileRetrievalDeletionSettled(purged)).toBe(true);
  expect(
    managedFileRetrievalDeletionSettled({
      ...purged,
      retrievalCreation: undefined,
    }),
  ).toBe(false);
  expect(
    managedFileRetrievalDeletionSettled({
      ...admitted,
      managedRetrieval: published.managedRetrieval,
    }),
  ).toBe(false);
  for (const changed of [
    { file_id: 'another-file' },
    { uploadOperationId: 'another-upload' },
    { tenantId: 'another-tenant' },
    { user: 'another-user' },
    { retentionAcceptedAt: new Date(now) },
    { retrievalCreation: { ...row.retrievalCreation, invented: true } },
  ])
    expect(managedFileRetrievalDeletionSettled({ ...row, ...changed })).toBe(false);
});
const inventoryProof = (
  row: FixtureFileRow,
  obligations: unknown[] = row.managedRetrieval?.obligations ?? [],
) => {
  const evidenceSha256 = captureManagedRetrievalInventoryEvidence(row).evidenceSha256;
  const payload = {
    backendIdentity: inventoryAuthority.backends[0].backendIdentity,
    owner: identity,
    fileId: 'source-a',
    evidenceSha256,
    observedAt: now,
    complete: true as const,
    obligations,
  };
  const inventoryReceiptSha256 = createHash('sha256')
    .update(canonicalManagedJson(payload))
    .digest('hex');
  return {
    reconciliationId: 'inventory-a',
    storeId: 'upload-store-a',
    revision: 4,
    observedAt: now,
    owner: identity,
    fileId: 'source-a',
    evidenceSha256,
    backends: [{ ...payload, inventoryReceiptSha256 }],
  };
};
const authorityFor = (proof: ReturnType<typeof inventoryProof>) => ({
  ...inventoryAuthority,
  backends: proof.backends.map(({ backendIdentity, inventoryReceiptSha256 }) => ({
    backendIdentity,
    inventoryReceiptSha256,
  })),
});
const issue = (row: Record<string, unknown>, obligations?: unknown[]) => {
  const proof = inventoryProof(row, obligations);
  return issueManagedRetrievalInventory(row, proof as never, authorityFor(proof));
};

it('creates unknown inventory and cannot infer known-empty from missing configuration', () => {
  const state = prepareManagedRetrievalPublication(fixture.revisionInput as never);
  expect(state).toEqual({
    version: 1,
    revision: fixture.revision,
    inventory: 'unknown',
    obligations: [],
  });
  expect(managedRetrievalDeletionSettled(state)).toBe(false);
  expect(
    prepareManagedRetrievalPublication({
      ...fixture.revisionInput,
      extractionPolicySha256: undefined,
    } as never),
  ).toBeUndefined();
  expect(managedRetrievalDeletionSettled(undefined)).toBe(false);
});
it('preserves liabilities on retry and refuses silent representation replacement', () => {
  const previous = {
    version: 1,
    revision: fixture.revision,
    inventory: 'unknown',
    obligations: [fixture.obligation],
  };
  expect(
    prepareManagedRetrievalPublication({ ...fixture.revisionInput, previous } as never),
  ).toEqual(previous);
  expect(() =>
    prepareManagedRetrievalPublication({
      ...fixture.revisionInput,
      extractionPolicySha256: 'e'.repeat(64),
      previous,
    } as never),
  ).toThrow();
  expect(() =>
    prepareManagedRetrievalPublication({
      ...fixture.revisionInput,
      extractionPolicySha256: undefined,
      previous,
    } as never),
  ).toThrow();
});
it('requires privately reconciled inventory and every terminal receipt before final deletion', () => {
  const state = {
    version: 1,
    revision: fixture.revision,
    inventory: 'known',
    obligations: [fixture.obligation],
  };
  expect(managedRetrievalDeletionSettled(state)).toBe(false);
  expect(
    managedRetrievalDeletionSettled({
      ...state,
      obligations: [{ ...fixture.obligation, state: 'purged' }],
    }),
  ).toBe(false);
  const terminal = {
    ...state,
    obligations: [
      {
        ...fixture.obligation,
        state: 'purged',
        purgeOperationId: 'purge-a',
        receiptSha256: fixture.purgeReceipt.receiptSha256,
      },
    ],
  };
  const row = { ...legacyRow(), managedRetrieval: { ...terminal, inventory: 'unknown' } };
  expect(managedRetrievalDeletionSettled(issue(row, terminal.obligations))).toBe(true);
  expect(managedRetrievalDeletionSettled({ ...terminal, inventory: 'unknown' })).toBe(false);
});

const query = (value: unknown) => {
  type Handle = {
    select: jest.Mock<Handle, []>;
    session: jest.Mock<Handle, []>;
    maxTimeMS: jest.Mock<Handle, []>;
    limit: jest.Mock<Handle, []>;
    hint: jest.Mock<Handle, []>;
    lean: jest.Mock<Promise<unknown>, []>;
  };
  const handle: Handle = {
    select: jest.fn(() => handle),
    session: jest.fn(() => handle),
    maxTimeMS: jest.fn(() => handle),
    limit: jest.fn(() => handle),
    hint: jest.fn(() => handle),
    lean: jest.fn(async () => value),
  };
  return handle;
};
it('keeps private index liabilities out of both ordinary File serializers', () => {
  expect(fileSchema.path('managedRetrieval').options.select).toBe(false);
  const Model = mongoose.model('ManagedRetrievalPrivacyFixture', fileSchema);
  try {
    const document = new Model({
      file_id: 'source-a',
      managedRetrieval: {
        version: 1,
        revision: fixture.revision,
        inventory: 'unknown',
        obligations: [fixture.obligation],
      },
    });
    expect(document.toJSON()).not.toHaveProperty('managedRetrieval');
    expect(document.toObject()).not.toHaveProperty('managedRetrieval');
  } finally {
    mongoose.deleteModel('ManagedRetrievalPrivacyFixture');
  }
});
it('the actual finalizer leaves unknown managed inventory pending without releasing metadata', async () => {
  const row = {
    _id: 'row-a',
    file_id: 'source-a',
    uploadOperationId: 'source-a',
    deletionRequestedAt: new Date(),
    retainedDerivativeBytes: 0,
    managedRetrieval: {
      version: 1,
      revision: fixture.revision,
      inventory: 'unknown',
      obligations: [],
    },
  };
  const File = {
    find: jest.fn(() => query([row])),
    findOne: jest.fn(() => query(row)),
    updateOne: jest.fn(),
  };
  const session = {
    inTransaction: () => true,
    withTransaction: async (fn: () => unknown) => fn(),
    endSession: jest.fn(),
  };
  const owner = createFileRetentionMethods({
    models: { File },
    startSession: async () => session,
  } as never);
  expect(await owner.finalizeFileSourceDeletion(fixture.revisionInput.owner, ['source-a'])).toEqual(
    { completedFileIds: [] },
  );
  expect(File.updateOne).not.toHaveBeenCalled();
  expect(session.endSession).toHaveBeenCalledTimes(1);
});

it('strips private retrieval data and dotted forgeries from ordinary File creation', async () => {
  const File = { findOneAndUpdate: jest.fn(() => query({ file_id: 'source-a' })) };
  const owner = createFileMethods({ models: { File } } as never);
  await owner.createFile(
    {
      file_id: 'source-a',
      managedRetrieval: { forged: true },
      'managedRetrieval.inventory': 'known',
      retrievalCreation: { forged: true },
      'retrievalCreation.state': 'empty',
    } as never,
    true,
  );
  const data = (File.findOneAndUpdate.mock.calls as unknown as unknown[][])[0][1];
  expect(data).not.toHaveProperty('managedRetrieval');
  expect(Object.keys(data as object)).not.toContain('managedRetrieval.inventory');
  expect(JSON.stringify(data)).not.toContain('retrievalCreation');
});
it('strips private retrieval data and dotted forgeries from ordinary File updates', async () => {
  const File = {
    findOne: jest.fn(() => query({ file_id: 'source-a' })),
    findOneAndUpdate: jest.fn(() => query({ file_id: 'source-a' })),
  };
  const owner = createFileMethods({ models: { File } } as never);
  await owner.updateFile({
    file_id: 'source-a',
    filename: 'renamed.txt',
    managedRetrieval: { forged: true },
    'managedRetrieval.inventory': 'known',
    retrievalCreation: { forged: true },
    'retrievalCreation.state': 'empty',
  } as never);
  const data = (File.findOneAndUpdate.mock.calls as unknown as unknown[][])[0][1];
  expect(JSON.stringify(data)).not.toContain('managedRetrieval');
  expect(JSON.stringify(data)).not.toContain('retrievalCreation');
});

function lifecycle(
  row: FixtureFileRow = legacyRow(),
  generationOwner?: Pick<GenerationManager, 'revokeFileSourceGenerations'>,
) {
  const calls: string[] = [];
  const session = {
    inTransaction: () => true,
    withTransaction: async (fn: () => unknown) => fn(),
    endSession: jest.fn(),
  };
  const File = {
    find: jest.fn(() => query([row])),
    findOne: jest.fn((filter) =>
      query(filter['derivedOrigin.ancestors.subject.operationId'] ? null : row),
    ),
    updateOne: jest.fn(async (_filter, update, options) => {
      expect(options.session).toBe(session);
      Object.assign(row, update.$set ?? {});
      for (const key of Object.keys(update.$unset ?? {})) delete row[key];
      return { acknowledged: true, matchedCount: 1 };
    }),
  };
  const mongo = { models: { File }, startSession: async () => session };
  const methods = createFileRetentionMethods(mongo as never);
  const global = {
    storeId: 'upload-store-a',
    revision: 4,
    enabled: false,
    reconciliationFence: { revision: 4, observedAt: now },
  };
  const store = {
    mongoose: mongo,
    Operation: { exists: () => ({ session: async () => false }) },
    transaction: async <T>(
      fn: (activeSession: typeof session, state: typeof global) => Promise<T>,
    ) => fn(session, global),
  };
  const activation = createUploadActivationMethods(store as never, {
    retrievalInventoryAuthority: authorityFor(inventoryProof(row)),
  });
  const cleanup = {
    beginFileDeletion: jest.fn(async (_owner, fileId) => ({ fileId })),
    removeFileOriginal: jest.fn(async () => {
      calls.push('original');
      return { writerStopped: true, originalAbsent: true };
    }),
    finishFileDeletion: jest.fn(async () => {
      calls.push('finish');
    }),
  };
  const db = {
    ...methods,
    revokeFileSources: jest.fn(async () => {
      row.deletionRequestedAt ??= new Date(now);
      return { revokedFileIds: [row.file_id] };
    }),
    redactFileSourceContent: jest.fn(async () => {
      calls.push('history');
    }),
    removeAgentResourceFilesFromAllAgents: jest.fn(async () => {}),
    prepareFileSourceDeletion: async (
      ...args: Parameters<typeof methods.prepareFileSourceDeletion>
    ) => {
      calls.push('prepare');
      return methods.prepareFileSourceDeletion(...args);
    },
    finalizeFileSourceDeletion: async (
      ...args: Parameters<typeof methods.finalizeFileSourceDeletion>
    ) => {
      calls.push('finalize');
      return methods.finalizeFileSourceDeletion(...args);
    },
  };
  // Execute the unchanged actual App consumer function with finite ports, not a rewritten copy.
  // Mongo durability and external backends are deliberately outside this no-DB test.
  const source = readFileSync(
    resolve(__dirname, '../../../../api/server/services/Files/process.js'),
    'utf8',
  );
  const start = source.indexOf('const processDeleteRequest =');
  const end = source.indexOf('\nconst processFileURL =', start);
  if (start < 0 || end < 0) throw new Error('Actual App consumer not found');
  const exported = {} as { processDeleteRequest(input: unknown): Promise<unknown> };
  const fileDeletionWorkOwner = createFileDeletionWorkOwner();
  runInNewContext(
    source.slice(start, end) + '\nexports.processDeleteRequest = processDeleteRequest;',
    {
      exports: exported,
      fileDeletionWorkOwner,
      requestManagedFileDeletion,
      db,
      require: (name: string) => {
        if (name === '~/server/services/Uploads') return { getUploadRuntime: () => ({ cleanup }) };
        if (name === '@librechat/api') return { purgeFileSourceCheckpoints: async () => undefined };
        throw new Error('Unexpected dependency ' + name);
      },
      GenerationJobManager: generationOwner ?? {
        revokeFileSourceGenerations: async () => ({ complete: true, pending: [] }),
      },
      FileSources: { local: 'local', text: 'text', openai: 'openai', azure: 'azure' },
      EModelEndpoint: {},
      checkOpenAIStorage: () => false,
      createDeleteFileWithSecondaryStorage: ({
        deleteFile,
      }: {
        deleteFile: () => Promise<unknown>;
      }) => deleteFile,
      enqueueDeleteOperation: ({
        deleteFile,
        promises,
        resolvedFileIds,
        file,
        work,
      }: {
        deleteFile: () => Promise<unknown>;
        promises: Promise<unknown>[];
        resolvedFileIds: Set<string>;
        file: { file_id: string };
        work: { effect<T>(start: () => Promise<T>): Promise<T> };
      }) =>
        promises.push(
          work.effect(() => deleteFile().then(() => resolvedFileIds.add(file.file_id))),
        ),
      logger: { error: () => {}, warn: () => {} },
    },
  );
  const remove = () =>
    exported.processDeleteRequest({
      req: { user: { id: identity.userId, tenantId: identity.tenantId }, config: {}, body: {} },
      files: [row],
    });
  return {
    row,
    File,
    methods,
    activation,
    store,
    global,
    session,
    cleanup,
    calls,
    remove,
    db,
    fileDeletionWorkOwner,
  };
}

it('actual App deletion preserves unknown legacy original/extraction/history evidence before any destructive step', async () => {
  const test = lifecycle();
  await expect(test.remove()).rejects.toThrow('Document source');
  expect(test.calls).toEqual([]);
  expect(test.row.text).toBe(fixture.revisionInput.document.text);
  expect(test.row.securityApproval).toEqual(fixture.revisionInput.approval);
  expect(await test.methods.prepareFileSourceDeletion(identity, ['source-a'])).toEqual({
    preparedFileIds: [],
  });
  expect(test.File.updateOne).not.toHaveBeenCalled();
});

it('unknown and pending index obligations cannot pass actual App or direct preparation', async () => {
  const test = lifecycle({
    ...legacyRow(),
    managedRetrieval: {
      version: 1,
      revision: fixture.revision,
      inventory: 'unknown',
      obligations: [fixture.obligation],
    },
  });
  await test.activation.reconcileFileRetrievalInventory(
    inventoryProof(test.row, [fixture.obligation]) as never,
    now,
  );
  expect(test.row.managedRetrieval!.inventory).toBe('known');
  await expect(test.remove()).rejects.toThrow();
  expect(test.calls).toEqual([]);
  expect(test.row.documentStructure).toEqual(fixture.revisionInput.document.structure);
});

it.each([
  'absent authority',
  'enabled writer',
  'expired observation',
  'stale global revision',
  'wrong store',
])('%s cannot issue a known inventory', async (caseName) => {
  const test = lifecycle();
  const proof = inventoryProof(test.row);
  let methods = test.activation;
  let observedNow = now;
  if (caseName === 'absent authority') methods = createUploadActivationMethods(test.store as never);
  if (caseName === 'enabled writer') test.global.enabled = true;
  if (caseName === 'expired observation') observedNow += 300_001;
  if (caseName === 'stale global revision') proof.revision++;
  if (caseName === 'wrong store') proof.storeId = 'another-store';
  await expect(
    methods.reconcileFileRetrievalInventory(proof as never, observedNow),
  ).rejects.toThrow();
  expect(test.File.updateOne).not.toHaveBeenCalled();
});

it.each([
  'no writer receipts',
  'missing backend',
  'backend receipt mismatch',
  'source mutation',
  'owner mismatch',
  'file mismatch',
  'incomplete census',
])('%s cannot turn absent state into known-empty', (caseName) => {
  const row = legacyRow();
  const proof = inventoryProof(row);
  const authority = structuredClone(authorityFor(proof));
  if (caseName === 'no writer receipts') authority.writers = [];
  if (caseName === 'missing backend') proof.backends = [];
  if (caseName === 'backend receipt mismatch')
    proof.backends[0].inventoryReceiptSha256 = '4'.repeat(64);
  if (caseName === 'source mutation') row.text += 'changed';
  if (caseName === 'owner mismatch') proof.owner = { ...identity, userId: 'other-owner' };
  if (caseName === 'file mismatch') proof.fileId = 'other-file';
  if (caseName === 'incomplete census') proof.backends[0].complete = false as never;
  expect(() => issueManagedRetrievalInventory(row, proof as never, authority)).toThrow();
});

it('an absent backend row cannot discard a previously admitted full-key liability', () => {
  const row = {
    ...legacyRow(),
    managedRetrieval: {
      version: 1,
      revision: fixture.revision,
      inventory: 'unknown',
      obligations: [fixture.obligation],
    },
  };
  expect(() => issue(row, [])).toThrow();
});

it('already redacted legacy rows remain unresolved without full census; valid census never invents revision/index keys', () => {
  const row: FixtureFileRow = legacyRow();
  delete row.text;
  delete row.documentStructure;
  delete row.securityApproval;
  expect(managedRetrievalDeletionSettled(row.managedRetrieval)).toBe(false);
  const state = issue(row);
  expect(state.revision).toBeNull();
  expect(state.legacy?.missingEvidence).toEqual(['revision', 'original', 'extraction']);
  expect(state.obligations).toEqual([]);
  expect(managedRetrievalDeletionSettled(state, { owner: identity, fileId: 'source-a' })).toBe(
    true,
  );
  expect(
    managedRetrievalDeletionSettled(state, {
      owner: { ...identity, userId: 'other' },
      fileId: 'source-a',
    }),
  ).toBe(false);
});

it.each(['unknown inventory', 'open obligation'])(
  'actual App fences generation/replay and aborts provider before %s can hold deletion',
  async (inventory) => {
    const generation = await boundGeneration();
    const row: FixtureFileRow =
      inventory === 'open obligation'
        ? {
            ...legacyRow(),
            managedRetrieval: {
              version: 1,
              revision: fixture.revision,
              inventory: 'unknown',
              obligations: [fixture.obligation],
            },
          }
        : legacyRow();
    delete row.deletionRequestedAt;
    const test = lifecycle(row, generation.manager);
    let deletion: Promise<unknown> | undefined;
    try {
      if (inventory === 'open obligation')
        await test.activation.reconcileFileRetrievalInventory(
          inventoryProof(test.row) as never,
          now,
        );
      let settled = false;
      deletion = test.remove();
      void deletion!.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await boundedAbort(generation.aborted);
      expect(test.row.deletionRequestedAt).toBeInstanceOf(Date);
      expect(generation.target.abortController.signal.aborted).toBe(true);
      expect(settled).toBe(false);
      expect(generation.replayPurge).toHaveBeenCalledWith(
        generation.target.streamId,
        generation.target.createdAt,
      );
      expect(await generation.manager.getResumeState(generation.target.streamId)).toBeNull();
      await generation.store.updateJob(
        generation.target.streamId,
        { finalEvent: '{"text":"late revoked source"}' },
        generation.target.createdAt,
      );
      expect(
        (await generation.store.getJob(generation.target.streamId))?.finalEvent,
      ).toBeUndefined();
      for (const other of [generation.unrelated, generation.foreign, generation.otherTenant]) {
        expect(other.abortController.signal.aborted).toBe(false);
        expect((await generation.store.getJob(other.streamId))?.status).toBe('running');
      }
      expect(generation.onDone).not.toHaveBeenCalled();
      expect(test.calls).toEqual([]);
      expect(test.row.securityApproval).toEqual(fixture.revisionInput.approval);
      expect(await generation.drain()).toBe(true);
      await expect(deletion).rejects.toThrow('Document source');
      expect(generation.onDone).not.toHaveBeenCalled();
      expect(await generation.manager.getResumeState(generation.target.streamId)).toBeNull();
      expect(test.calls).toEqual([]);
      expect(test.row.text).toBe(fixture.revisionInput.document.text);
      expect(test.row.documentStructure).toEqual(fixture.revisionInput.document.structure);
      expect(test.row.deletionCompletedAt).toBeUndefined();
    } finally {
      await generation.drain();
      await deletion?.catch(() => undefined);
      await generation.manager.destroy();
    }
  },
);
