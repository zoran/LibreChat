import type { IJobStoreV2, SerializableJobData } from '../../interfaces/IJobStore';
import { createSourceReplayIntent } from '../../internal/sourceBudget';

export { configureSourceReplayForTest } from './sourceReplayQuota';

export async function prepareSourceReplayForTest(
  store: IJobStoreV2,
  job: SerializableJobData,
  sourceExpiresAt = Date.now() + 60_000,
) {
  const intent = await store.prepareSourceReplay!(
    createSourceReplayIntent(job, ['file-a'], sourceExpiresAt),
  );
  if (!(await store.commitSourceReplay!(intent))) throw new Error('Fixture source commit failed');
  return intent;
}
