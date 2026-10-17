/** Real local attempt journal; the durable repository is an explicitly labelled in-memory fake. */
import { readUploadPromotionRecord } from 'librechat-data-provider';
import type {
  UploadCleanupTask,
  UploadPromotionRecord,
  UploadPromotionSettlement,
} from 'librechat-data-provider';
import type { UploadAttemptSettlement } from '../contract';
import type { UploadAttemptJournal } from '../attempts';
import { settleUploadPromotionCleanup } from './promotion-cleanup';
import { createUploadAttemptJournal } from '../attempts';

const app = { hostId: 'app-host', instanceId: 'app-current' };
const intake = { hostId: 'intake-host', instanceId: 'intake-current' };
const sha256 = 'a'.repeat(64);
const integrity = {
  version: 1 as const,
  algorithm: 'sha256' as const,
  sha256,
  chunkBytes: 262144 as const,
  chunkSha256: [sha256],
};
const promotion = (): UploadPromotionRecord => ({
  version: 1,
  promotionId: '11111111-1111-4111-8111-111111111111',
  lease: {
    tenantId: 'tenant',
    userId: 'user',
    operationId: 'operation',
    generation: 3,
    kind: 'transfer',
    ...intake,
    expiresAt: '2026-10-17T01:00:00.000Z',
  },
  worker: { ...app },
  integrity: { ...integrity, chunkSha256: [...integrity.chunkSha256] },
  approval: {
    version: 1,
    decision: 'approved',
    policySha256: 'b'.repeat(64),
    subject: {
      tenantId: 'tenant',
      userId: 'user',
      operationId: 'operation',
      transferGeneration: 3,
      mediaType: 'text/plain',
      bytes: 8,
      sha256,
    },
    scannerVersion: 'explicit-simulated-scanner-fixture',
    checkedAt: '2026-10-17T00:00:00.000Z',
    coverage: { complete: true, pages: 1, parts: 1 },
  },
  metadata: { filename: 'approved.txt' },
  state: 'writing',
  writerStopped: false,
  receipt: {
    outcome: 'durable',
    source: 's3',
    bytes: 8,
    filepath: '/api/files/operation',
    storageKey: 't/tenant/managed-uploads/user/operation.3__original',
    integrity: { ...integrity, chunkSha256: [...integrity.chunkSha256] },
  },
});
const task = (): UploadCleanupTask => ({
  operationId: 'operation',
  generation: 9,
  attemptGeneration: 3,
  principal: { authentication: 'verified-email', tenantId: 'tenant', userId: 'user' },
  worker: intake,
  state: 'failed',
  writerStopped: false,
  localCopiesAbsent: false,
  promotion: promotion(),
});
const proof: UploadAttemptSettlement = {
  writerStopped: true,
  localCopiesAbsent: true,
  storageOutcome: 'durable',
};

describe('App promotion cleanup join', () => {
  const journals: UploadAttemptJournal[] = [];
  afterEach(async () => {
    await Promise.all(journals.splice(0).map((journal) => journal.close(AbortSignal.abort())));
  });
  function setup(value = task()) {
    const journal = createUploadAttemptJournal(app);
    journals.push(journal);
    const stored = readUploadPromotionRecord(value.promotion);
    const settlePromotion = jest.fn(
      async (settlement: UploadPromotionSettlement, _now: number) =>
        readUploadPromotionRecord({
          ...stored,
          state: 'settled',
          writerStopped: settlement.writerStopped,
          ...(settlement.receipt ? { receipt: settlement.receipt } : {}),
        })!,
    );
    const options = {
      task: value,
      worker: { ...app },
      attempts: journal.attempts,
      repository: { settlePromotion },
      signal: new AbortController().signal,
      now: () => 42,
    };
    function register(result = proof, generation = 3) {
      const abort = jest.fn();
      const registration = journal.attempts.begin(abort);
      registration.bind({ ...app, operationId: 'operation', generation });
      registration.settle(result);
      return { registration, abort };
    }
    return { journal, options, settlePromotion, register };
  }

  it.each(['none', 'prepared', 'settled'])(
    'needs no local join for %s promotion',
    async (state) => {
      const value = task();
      if (state === 'none') delete value.promotion;
      else {
        value.promotion!.state = state as 'prepared' | 'settled';
        value.promotion!.writerStopped = true;
        if (state === 'prepared') delete value.promotion!.receipt;
      }
      const { options, settlePromotion } = setup(value);
      options.worker.instanceId = 'another-app';
      expect(await settleUploadPromotionCleanup(options)).toBe(true);
      expect(settlePromotion).not.toHaveBeenCalled();
    },
  );

  it('joins the actual App writer on the original generation and retains the known receipt', async () => {
    const { options, register, settlePromotion } = setup();
    register({ ...proof, localCopiesAbsent: false, securityPending: true });
    expect(await settleUploadPromotionCleanup(options)).toBe(true);
    expect(settlePromotion).toHaveBeenCalledWith(
      {
        operationId: 'operation',
        transferGeneration: 3,
        promotionId: options.task.promotion!.promotionId,
        worker: app,
        writerStopped: true,
        receipt: options.task.promotion!.receipt,
      },
      42,
    );
    expect(options.task.writerStopped).toBe(false);
    expect(options.task.localCopiesAbsent).toBe(false);
  });

  it('waits for actual completion after cancellation; cancel alone is insufficient', async () => {
    const { journal, options, settlePromotion } = setup();
    const abort = jest.fn();
    const registration = journal.attempts.begin(abort);
    registration.bind({ ...app, operationId: 'operation', generation: 3 });
    const pending = settleUploadPromotionCleanup(options);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(settlePromotion).not.toHaveBeenCalled();
    registration.settle(proof);
    expect(await pending).toBe(true);
  });

  it('snapshots promotion identity and receipt before awaiting the actual join', async () => {
    const { journal, options, settlePromotion } = setup();
    const registration = journal.attempts.begin(jest.fn());
    registration.bind({ ...app, operationId: 'operation', generation: 3 });
    const pending = settleUploadPromotionCleanup(options);
    options.task.promotion!.receipt!.filepath = '/mutated';
    options.task.promotion!.metadata.filename = 'mutated.txt';
    options.worker.instanceId = 'mutated';
    registration.settle(proof);
    expect(await pending).toBe(true);
    expect(settlePromotion.mock.calls[0][0]).toMatchObject({
      worker: app,
      receipt: { filepath: '/api/files/operation' },
    });
  });

  it.each(['missing', 'wrong-generation', 'foreign-host', 'foreign-incarnation'])(
    'fails closed for %s local ownership/evidence',
    async (change) => {
      const { options, register, settlePromotion } = setup();
      if (change !== 'missing') register(proof, change === 'wrong-generation' ? 9 : 3);
      if (change === 'foreign-host') options.worker.hostId = 'other';
      if (change === 'foreign-incarnation') options.worker.instanceId = 'old';
      expect(await settleUploadPromotionCleanup(options)).toBe(false);
      expect(settlePromotion).not.toHaveBeenCalled();
    },
  );

  it.each(['stored-unknown', 'journal-unknown', 'missing-outcome', 'not-joined', 'contradictory'])(
    'retains uncertainty for %s',
    async (change) => {
      const { options, register, settlePromotion } = setup();
      const result = { ...proof };
      if (change === 'stored-unknown') options.task.promotion!.receipt!.outcome = 'unknown';
      if (change === 'journal-unknown') result.storageOutcome = 'unknown';
      if (change === 'missing-outcome') delete result.storageOutcome;
      if (change === 'not-joined') result.writerStopped = false;
      if (change === 'contradictory') result.storageOutcome = 'absent';
      register(result);
      expect(await settleUploadPromotionCleanup(options)).toBe(false);
      expect(settlePromotion).not.toHaveBeenCalled();
    },
  );

  it('can settle a proven no-start join without inventing a receipt or original absence', async () => {
    const value = task();
    delete value.promotion!.receipt;
    const { options, register, settlePromotion } = setup(value);
    register({ ...proof, storageOutcome: 'not_started' });
    expect(await settleUploadPromotionCleanup(options)).toBe(true);
    expect(settlePromotion.mock.calls[0][0]).not.toHaveProperty('receipt');
    expect(settlePromotion.mock.calls[0][0]).not.toHaveProperty('originalAbsent');
  });

  it.each(['already', 'while-joining', 'after-join'])(
    'does not acknowledge cleanup when aborted %s',
    async (phase) => {
      const { journal, options, settlePromotion } = setup();
      const controller = new AbortController();
      options.signal = controller.signal;
      const registration = journal.attempts.begin(() => {
        if (phase === 'after-join') {
          registration.settle(proof);
          controller.abort();
        }
      });
      registration.bind({ ...app, operationId: 'operation', generation: 3 });
      if (phase === 'already') controller.abort();
      const pending = settleUploadPromotionCleanup(options);
      if (phase === 'while-joining') controller.abort();
      expect(await pending).toBe(false);
      registration.settle(proof);
      expect(settlePromotion).not.toHaveBeenCalled();
    },
  );

  it.each(['operation', 'generation', 'tenant', 'user', 'schema'])(
    'rejects mismatched %s task/promotion without joining',
    async (change) => {
      const { options, register, settlePromotion } = setup();
      register();
      if (change === 'operation') options.task.operationId = 'other';
      if (change === 'generation') options.task.attemptGeneration = 4;
      if (change === 'tenant') options.task.principal.tenantId = 'other';
      if (change === 'user') options.task.principal.userId = 'other';
      if (change === 'schema') options.task.promotion!.writerStopped = true;
      expect(await settleUploadPromotionCleanup(options)).toBe(false);
      expect(settlePromotion).not.toHaveBeenCalled();
    },
  );

  it.each(['promotion', 'metadata', 'worker'])(
    'does not invoke a supplied %s getter',
    async (field) => {
      const { options, register, settlePromotion } = setup();
      register();
      const getter = jest.fn(() => {
        throw new Error('must not run');
      });
      if (field === 'promotion') Object.defineProperty(options.task, 'promotion', { get: getter });
      if (field === 'metadata')
        Object.defineProperty(options.task.promotion!.metadata, 'filename', { get: getter });
      if (field === 'worker') Object.defineProperty(options.worker, 'hostId', { get: getter });
      expect(await settleUploadPromotionCleanup(options)).toBe(false);
      expect(getter).not.toHaveBeenCalled();
      expect(settlePromotion).not.toHaveBeenCalled();
    },
  );

  it.each(['failure', 'foreign-result', 'unjoined-result'])(
    'fails closed on repository %s',
    async (change) => {
      const { options, register, settlePromotion } = setup();
      register();
      if (change === 'failure')
        settlePromotion.mockRejectedValue(new Error('acknowledgement lost'));
      else
        settlePromotion.mockResolvedValue({
          ...promotion(),
          state: change === 'unjoined-result' ? 'writing' : 'settled',
          writerStopped: change !== 'unjoined-result',
          promotionId:
            change === 'foreign-result'
              ? '22222222-2222-4222-8222-222222222222'
              : promotion().promotionId,
        });
      expect(await settleUploadPromotionCleanup(options)).toBe(false);
    },
  );
});
