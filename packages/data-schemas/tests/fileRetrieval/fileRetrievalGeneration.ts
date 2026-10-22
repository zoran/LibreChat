/** Actual finite generation abort/drain and replay owner for File consumer regressions. */
const {
  configureSourceReplayForTest,
}: {
  configureSourceReplayForTest: (
    manager: InstanceType<typeof GenerationJobManagerClass>,
    store: InstanceType<typeof InMemoryJobStore>,
  ) => void;
} = jest.requireActual('../../../api/src/stream/__tests__/helpers/sourceReplayQuota');
import fixture from '../../../data-provider/src/__fixtures__/managed-retrieval-v1.json';
const {
  GenerationJobManagerClass,
  InMemoryJobStore,
  InMemoryEventTransport,
}: typeof import('@librechat/api', { with: { 'resolution-mode': 'require' } }) =
  jest.requireActual('@librechat/api');
type Manager = InstanceType<typeof GenerationJobManagerClass>;
type SourceJob = Awaited<ReturnType<Manager['createJob']>>;
interface BoundGeneration {
  manager: Manager;
  store: InstanceType<typeof InMemoryJobStore>;
  target: SourceJob;
  unrelated: SourceJob;
  foreign: SourceJob;
  otherTenant: SourceJob;
  aborted: Promise<void>;
  onDone: jest.Mock;
  replayPurge: jest.SpyInstance;
  drain(): Promise<boolean>;
  releasePurge(): void;
}
async function createBoundGeneration(
  holdPurge: boolean = false,
  identity: { userId: string; tenantId: string } = fixture.revisionInput.owner,
): Promise<BoundGeneration> {
  const store = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
  const originalPurge = store.purgeSourceRetention.bind(store);
  let purgeUnavailable = holdPurge;
  // Configure the port before the manager captures/binds its concrete store methods.
  if (holdPurge)
    store.purgeSourceRetention = async (...args) =>
      purgeUnavailable ? false : originalPurge(...args);
  const releasePurge = () => {
    purgeUnavailable = false;
  };
  const transport = new InMemoryEventTransport();
  const manager = new GenerationJobManagerClass();
  manager.configure({ jobStore: store, eventTransport: transport, isRedis: false });
  configureSourceReplayForTest(manager, store);
  manager.initialize();
  const make = async (id: string, userId: string, tenantId: string, fileId: string) => {
    const job = await manager.createJob(id, userId, id, { trustedTenantId: tenantId });
    expect(
      await manager.bindSourceRetention(id, job.createdAt, {
        sourceFileIds: [fileId],
        sourceExpiresAt: new Date(Date.now() + 60_000),
      }),
    ).toBe(true);
    return job;
  };
  try {
    const target = await make('inventory-target', identity.userId, identity.tenantId, 'source-a');
    const unrelated = await make(
      'inventory-other-source',
      identity.userId,
      identity.tenantId,
      'unrelated-source',
    );
    const foreign = await make(
      'inventory-other-owner',
      'other-owner',
      identity.tenantId,
      'source-a',
    );
    const otherTenant = await make(
      'inventory-other-tenant',
      identity.userId,
      'other-tenant',
      'source-a',
    );
    const executionId = target.metadata.providerExecutionId!;
    expect(
      await manager.beginProviderExecution(target.streamId, target.createdAt, executionId),
    ).toBe(true);
    let releaseAbort!: () => void;
    const aborted = new Promise<void>((resolveAbort) => {
      releaseAbort = resolveAbort;
    });
    target.abortController.signal.addEventListener('abort', releaseAbort, { once: true });
    const onDone = jest.fn();
    await manager.subscribe(target.streamId, () => undefined, onDone);
    const replayPurge = jest.spyOn(transport, 'purgeSourceRetention');
    const drain = () =>
      manager.markProviderExecutionDrained(target.streamId, target.createdAt, executionId);
    return {
      manager,
      store,
      target,
      unrelated,
      foreign,
      otherTenant,
      aborted,
      onDone,
      replayPurge,
      drain,
      releasePurge,
    };
  } catch (error) {
    await manager.destroy();
    throw error;
  }
}

async function abortWithinFixture(promise: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Source provider was not aborted')), 2_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export const boundGeneration: typeof createBoundGeneration = createBoundGeneration;
export const boundedAbort: typeof abortWithinFixture = abortWithinFixture;
