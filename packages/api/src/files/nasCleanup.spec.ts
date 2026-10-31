/** NAS cleanup through actual consumers; no receipt shape or fabricated claim proves completion. */
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';

import type { FileCleanupComposition } from './lifecycleCleanup';
import type { StoragePort } from '../uploads/contract';
import type { NasStoragePort } from '../storage/nas';
import { nasFixture, housekeepingFixture, principal } from './nasCleanup.fixture';
import { createManagedUploadCleanup } from '../uploads/cleanup';
import { createFileCleanupPort } from './lifecycleCleanup';
import { getNasS3StorageCapture } from '../storage/nas';

const signal = new AbortController().signal;
const pending = { state: 'pending', code: 'owner_pending' };
function legacyStorage() {
  const external = jest.fn(() => {
    throw Error('Unexpected managed storage fallback');
  });
  return {
    external,
    port: {
      describeDeletion: external,
      beginDeletion: external,
      observeDeletion: external,
      acknowledgeDeletionConsumed: external,
    } as unknown as StoragePort,
  };
}
async function original(receipt = true) {
  const f = nasFixture();
  if (!receipt) f.transport.on(GetObjectCommand).rejects(new Error('verification unavailable'));
  const result = await f.adapter.put(f.input());
  if (receipt) {
    expect(result.outcome).toBe('durable');
    f.row().original = result;
  } else expect(f.row().originalWrite?.state).toBe('acknowledged');
  f.cancel();
  return f;
}
async function uploadConsumer(
  f: Awaited<ReturnType<typeof original>>,
  nasStorage?: NasStoragePort,
) {
  const hk = await housekeepingFixture(f, false);
  const legacy = legacyStorage();
  const repository = {
    prepareHousekeepingCleanup: jest.fn(async () => ({ state: 'ready' as const, task: f.task() })),
    confirmHousekeepingCleanup: jest.fn(),
    prepareCleanupStorage: jest.fn(() => {
      throw Error('Legacy intent prohibited');
    }),
    recordCleanupStorage: jest.fn(),
    cleanupTasks: jest.fn(),
    cleanupForFile: jest.fn(),
    reconcile: jest.fn(),
    confirmCleanup: jest.fn(),
    delete: jest.fn(),
  };
  const port = createManagedUploadCleanup({ repository, storage: legacy.port, nasStorage });
  return { hk, legacy, repository, port };
}
function fileConsumer(
  f: Awaited<ReturnType<typeof original>>,
  hk: Awaited<ReturnType<typeof housekeepingFixture>>,
  nasStorage?: NasStoragePort,
) {
  const legacy = legacyStorage();
  const external = jest.fn(() => {
    throw Error('Unexpected generation handoff');
  });
  const ports = {
    entry: hk.entry,
    lifecycle: hk.life,
    nasStorage,
    storage: legacy.port,
    targets: { beginCapture: external },
    generations: { capture: external, reconcile: external, close: external },
    storageBudgetMs: 5000,
  } as unknown as FileCleanupComposition;
  return { port: createFileCleanupPort(ports), legacy, external };
}

it('uses the real task binding with no public receipt and commits NAS absence before releasing bytes', async () => {
  const f = await original(false);
  expect(f.task().original).toBeUndefined();
  expect(f.global.originalBytes).toBe(5);
  const c = await uploadConsumer(f, f.adapter);
  const actual = await c.port.reconcileCleanupOperation(c.hk.claim, signal);
  expect(actual).toEqual({
    state: 'settled',
    receiptRef: 'nas:' + f.row().cleanupCustody!.nas!.consumerCommitId,
  });
  expect(f.row().cleanupCustody?.nas?.state).toBe('consumed');
  expect(f.row().originalRemoved).toBe(true);
  expect(f.global.originalBytes).toBe(0);
  expect(f.transport.commandCalls(DeleteObjectCommand)).toHaveLength(1);
  expect(c.legacy.external).not.toHaveBeenCalled();
  expect(c.repository.prepareCleanupStorage).not.toHaveBeenCalled();
  expect(c.repository.confirmHousekeepingCleanup).not.toHaveBeenCalled();
});

it.each(['absent', 'forged', 'disposed', 'foreign-backend', 'foreign-bucket', 'wrong-generation'])(
  'keeps a NAS task pending without managed fallback for %s',
  async (variant) => {
    const f = await original(false);
    let adapter: NasStoragePort | undefined = f.adapter;
    if (variant === 'absent') adapter = undefined;
    if (variant === 'forged') adapter = { ...f.adapter };
    if (variant === 'disposed') f.client.destroy();
    const binding = f.row().writeBinding!;
    if (binding.version !== 2) throw Error('Expected authentic NAS binding');
    if (variant === 'foreign-backend')
      f.row().writeBinding = { ...binding, backend: { ...binding.backend, uid: 'foreign' } };
    if (variant === 'foreign-bucket')
      f.row().writeBinding = { ...binding, bucket: 'foreign-bucket' };
    if (variant === 'wrong-generation') f.row().attemptGeneration!++;
    const c = await uploadConsumer(f, adapter);
    expect(await c.port.reconcileCleanupOperation(c.hk.claim, signal)).toEqual(pending);
    expect(f.transport.commandCalls(DeleteObjectCommand)).toHaveLength(0);
    expect(f.global.originalBytes).toBe(5);
    expect(c.legacy.external).not.toHaveBeenCalled();
  },
);

it('forwards the actual store-issued HK claim to real NAS dispatch and consumption', async () => {
  const f = await original(false);
  const dispatch = jest.spyOn(f.repository, 'dispatchNasCleanup');
  const consume = jest.spyOn(f.repository, 'consumeNasCleanup');
  const c = await uploadConsumer(f, f.adapter);
  expect(c.hk.jobs[0].claim!.claimId).toBe(c.hk.claim.claimId);
  expect(c.hk.jobs[0].fence).toBe(c.hk.claim.fence);
  expect((await c.port.reconcileCleanupOperation(c.hk.claim, signal)).state).toBe('settled');
  expect(dispatch.mock.calls[0][3]).toBe(c.hk.claim);
  expect(consume.mock.calls[0][2]).toBe(c.hk.claim);
});

it('retains unknown original and lost DELETE acknowledgment without HEAD-derived replay', async () => {
  const f = await original(false);
  f.row().originalWrite!.state = 'unknown';
  delete f.row().originalWrite!.response;
  delete f.row().originalWrite!.acknowledgedAt;
  const c = await uploadConsumer(f, f.adapter);
  expect(await c.port.reconcileCleanupOperation(c.hk.claim, signal)).toEqual(pending);
  expect(f.transport.commandCalls(DeleteObjectCommand)).toHaveLength(0);
  expect(f.transport.commandCalls(HeadObjectCommand)).toHaveLength(0);
  expect(f.global.originalBytes).toBe(5);
  const g = await original(false);
  g.transport.on(DeleteObjectCommand).rejects(new Error('DELETE ACK lost'));
  const d = await uploadConsumer(g, g.adapter);
  expect(await d.port.reconcileCleanupOperation(d.hk.claim, signal)).toEqual(pending);
  expect(await d.port.reconcileCleanupOperation(d.hk.claim, signal)).toEqual(pending);
  expect(g.transport.commandCalls(DeleteObjectCommand)).toHaveLength(1);
  expect(g.transport.commandCalls(HeadObjectCommand)).toHaveLength(0);
  expect(g.row().cleanupCustody?.nas?.state).toBe('unknown');
  expect(g.global.originalBytes).toBe(5);
});

it('requires the real File source owner to admit NAS before prepareStorage and cleanup', async () => {
  const f = await original();
  const hk = await housekeepingFixture(f, true);
  const prepare = jest.spyOn(hk.life, 'prepareStorage');
  const c = fileConsumer(f, hk, f.adapter);
  // This must cross the real File source/tenant/HK owner, not a supplied progress shape.
  expect(await c.port.step(hk.claim, signal)).toEqual({ state: 'progress', receiptRef: null });
  expect(prepare).toHaveBeenCalledWith(hk.claim, signal);
  expect(hk.jobs[0].execution.phase).toBe('removing_original');
  expect(hk.custody().lifecycle!.storage).toBeNull();
  expect(f.transport.commandCalls(DeleteObjectCommand)).toHaveLength(0);
  expect(hk.unavailable).not.toHaveBeenCalled();
  expect(c.legacy.external).not.toHaveBeenCalled();
});

it.each(['retrieval', 'checkpoints', 'messages'] as const)(
  'the real File prepareStorage refuses incomplete %s before any original mutation',
  async (stage) => {
    const f = await original();
    const hk = await housekeepingFixture(f, true);
    hk.custody().lifecycle!.derivatives[stage] = 'pending';
    expect(await hk.life.prepareStorage(hk.claim, signal)).toMatchObject({ state: 'pending' });
    expect(hk.jobs[0].execution.phase).toBe('purging_derivatives');
    expect(f.transport.commandCalls(DeleteObjectCommand)).toHaveLength(0);
    expect(f.global.originalBytes).toBe(5);
  },
);

it('requires a genuine current File job claim and derivatives before actual NAS deletion', async () => {
  const f = await original();
  const hk = await housekeepingFixture(f, true);
  const base = { principal, operationId: f.row()._id, signal, deadlineAtMs: Date.now() + 5000 };
  expect(await f.adapter.cleanupOriginal(base)).toEqual({ state: 'pending' });
  expect(
    await f.adapter.cleanupOriginal({ ...base, claim: { ...hk.claim, fence: hk.claim.fence + 1 } }),
  ).toEqual({ state: 'pending' });
  hk.custody().lifecycle!.derivatives.messages = 'pending';
  expect(await f.adapter.cleanupOriginal({ ...base, claim: hk.claim })).toEqual({
    state: 'pending',
  });
  expect(f.transport.commandCalls(DeleteObjectCommand)).toHaveLength(0);
  expect(f.global.originalBytes).toBe(5);
  expect(hk.unavailable).not.toHaveBeenCalled();
});

it('cannot finalize File or release quota when the actual retention transaction is unavailable', async () => {
  const f = await original();
  const hk = await housekeepingFixture(f, true);
  expect(await hk.life.prepareStorage(hk.claim, signal)).toMatchObject({ state: 'progress' });
  expect(
    await f.adapter.cleanupOriginal({
      principal,
      operationId: f.row()._id,
      claim: hk.claim,
      signal,
      deadlineAtMs: Date.now() + 5000,
    }),
  ).toEqual({ state: 'pending' });
  expect(f.transport.commandCalls(DeleteObjectCommand)).toHaveLength(1);
  expect(f.errors).toEqual([expect.stringContaining('External File retention owner unavailable')]);
  expect({
    retentionCalls: hk.unavailable.mock.calls.length,
    errors: f.errors,
    phase: hk.jobs[0].execution.phase,
    nas: f.row().cleanupCustody?.nas?.state,
  }).toEqual({
    retentionCalls: 1,
    errors: expect.any(Array),
    phase: 'removing_original',
    nas: 'observed',
  });
  expect(f.global.originalBytes).toBe(5);
  expect(f.row().cleanupCustody?.nas?.state).toBe('observed');
  expect((await hk.life.finalize(hk.claim, signal)).state).toBe('pending');
  expect(hk.file().deletionCompletedAt).toBeUndefined();
});

it('refuses disposed and property-only File adapters with a real authenticated lifecycle', async () => {
  const f = await original();
  const hk = await housekeepingFixture(f, true);
  expect(await hk.life.prepareStorage(hk.claim, signal)).toMatchObject({ state: 'progress' });
  const snapshot = await hk.life.observe(hk.claim, signal);
  // A genuine observation is required; cannot fabricate it when the source guard refuses NAS.
  expect(snapshot.state).toBe('progress');
  const forged = { ...f.adapter };
  expect(getNasS3StorageCapture(forged)).toBeUndefined();
  const c = fileConsumer(f, hk, forged);
  expect(await c.port.step(hk.claim, signal)).toEqual(pending);
  expect(f.transport.commandCalls(DeleteObjectCommand)).toHaveLength(0);
  expect(c.legacy.external).not.toHaveBeenCalled();
});
