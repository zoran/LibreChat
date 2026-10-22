import type { GenerationJobManagerClass, IJobStoreV2 } from '../../../../dist/index.cjs';

/** Unit transport fixtures isolate File's private port; Mongo races have their own owner suite. */
export function configureSourceReplayForTest(
  manager: Pick<GenerationJobManagerClass, 'configureSourceReplay'>,
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
