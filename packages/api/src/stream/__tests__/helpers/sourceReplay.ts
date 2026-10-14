import type { IJobStoreV2, SerializableJobData } from '../../interfaces/IJobStore';
import type { GenerationJobManagerClass } from '../../GenerationJobManager';
import { createSourceReplayIntent } from '../../internal/sourceBudget';

/** Unit transport fixtures isolate File's private port; Mongo races have their own owner suite. */
export function configureSourceReplayForTest(
  manager: GenerationJobManagerClass,
  store: IJobStoreV2,
): void {
  manager.configureSourceReplay({
    quota: {
      reserveFileSourceCopies: async (_owner, input) => {
        const intent = (await store.listSourceReplayIntents!()).find(
          (row) => row.receipt.reservationId === input.reservationId,
        );
        if (!intent) throw new Error('Missing prepared fixture intent');
        return intent.receipt;
      },
      releaseFileSourceCopies: async () => undefined,
    },
  });
}

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
