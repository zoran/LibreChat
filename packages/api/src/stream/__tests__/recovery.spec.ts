import { logger } from '@librechat/data-schemas';
import type { RecoveredSteerPayload } from '../SteerRecovery';
import { getSteerRecoveryFailure, RecoveredSteerPayloadMismatchError } from '../SteerRecovery';
import { InMemoryJobStore, PARKED_STEERS_TTL_MS } from '../implementations/InMemoryJobStore';
import { serializeQuoteRetention } from '~/files/retention';
import { SteeringLifecycle } from '../SteeringLifecycle';

const proof: RecoveredSteerPayload = { text: 'original words', fileIds: [], quotes: [] };
const source = { steerId: 'source', text: proof.text, createdAt: 1 };

describe('recovery admission failures', () => {
  let store: InMemoryJobStore;
  beforeEach(() => {
    store = new InMemoryJobStore();
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await store.destroy();
  });
  const recover = (subject: InMemoryJobStore, payload = proof) =>
    subject.createJob(
      'conversation',
      'owner',
      'conversation',
      undefined,
      { generationProtocolVersion: 2 },
      'source',
      undefined,
      undefined,
      undefined,
      payload,
    );
  const park = async (subject: InMemoryJobStore, generationProtocolVersion: 1 | 2 = 2) => {
    const job = await subject.createJob('conversation', 'owner', 'conversation', undefined, {
      generationProtocolVersion,
    });
    await subject.parkSteers(
      'conversation',
      JSON.stringify({ userId: 'owner', steers: [source] }),
      job.createdAt,
    );
    return job;
  };

  test('selective quote purge keeps duplicate independent text, paired refs and replacement epoch', async () => {
    const first = await park(store);
    const refs = [{ messageId: 'a' }, null, { messageId: 'b' }];
    const quoteRetention = serializeQuoteRetention(
      {
        quotes: ['same', 'same', 'third'],
        sourceMessageConditions: [{ messageId: 'b', messageVersion: 7 }],
        quoteSourceRetention: [
          {
            index: 0,
            sourceRef: refs[0]!,
            sourceFileIds: ['file-a'],
            sourceExpiresAt: new Date(Date.now() + 60000),
          },
          {
            index: 2,
            sourceRef: refs[2]!,
            sourceFileIds: ['file-b'],
            sourceExpiresAt: new Date(Date.now() + 60000),
          },
        ],
      },
      refs,
    );
    await store.parkSteers(
      'conversation',
      JSON.stringify({
        userId: 'owner',
        steers: [
          {
            ...source,
            quotes: quoteRetention.quotes,
            quoteSourceRefs: refs,
            quoteRetention,
          },
        ],
      }),
      first.createdAt,
    );
    const replacement = await store.createJob('conversation', 'owner', 'conversation');
    expect(
      await store.purgeFileSourceRecovery('conversation', { userId: 'owner' }, ['file-a']),
    ).toBe(true);
    const parked = JSON.parse((await store.claimParkedSteers('conversation', 'owner'))!);
    expect(parked.steers[0]).toMatchObject({
      text: proof.text,
      quotes: ['same', 'third'],
      quoteSourceRefs: [null, refs[2]],
    });
    expect(parked.steers[0].quoteRetention.quoteSourceRetention[0].index).toBe(1);
    const retained = await new SteeringLifecycle(store).getRecoveredQuoteRetention(
      'conversation',
      'source',
      { userId: 'owner' },
    );
    expect(retained?.sourceMessageConditions).toEqual([]);
    expect(retained?.quoteSourceRetention[0].sourceExpiresAt.getTime()).toBe(
      quoteRetention.quoteSourceRetention[1].sourceExpiresAt,
    );
    expect((await store.getJob('conversation'))?.createdAt).toBe(replacement.createdAt);
  });

  test('equal quote text with a changed source ref cannot consume the parked generation', async () => {
    const job = await park(store);
    const quoteSourceRefs = [{ messageId: 'source-message', quoteIndex: 1, messageVersion: 3 }];
    await store.parkSteers(
      'conversation',
      JSON.stringify({
        userId: 'owner',
        steers: [
          {
            ...source,
            quotes: ['same'],
            quoteSourceRefs,
          },
        ],
      }),
      job.createdAt,
    );
    await expect(
      recover(store, {
        ...proof,
        quotes: ['same'],
        quoteSourceRefs: [
          {
            ...quoteSourceRefs[0],
            quoteIndex: 0,
          },
        ],
      }),
    ).rejects.toMatchObject({ reason: 'payload_mismatch' });
    expect((await store.getJob('conversation'))?.createdAt).toBe(job.createdAt);
    const recovered = await recover(store, { ...proof, quotes: ['same'], quoteSourceRefs });
    expect(recovered.recoveredSteerId).toBe('source');
  });

  test('missing source is not diagnosed as changed text', async () => {
    await expect(recover(store)).rejects.toMatchObject({
      code: 'RECOVERY_PAYLOAD_MISMATCH',
      reason: 'source_missing',
    });
    expect(await store.getJob('conversation')).toBeNull();
  });

  test('an expired source reports source_missing', async () => {
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now);
    await park(store);
    jest.spyOn(Date, 'now').mockReturnValue(now + PARKED_STEERS_TTL_MS + 1);
    await expect(recover(store)).rejects.toMatchObject({ reason: 'source_missing' });
  });

  test('already consumed source reports source_missing and preserves the winning job', async () => {
    await park(store);
    const job = await recover(store);
    expect(
      await store.consumeParkedSteer('conversation', 'source', 'owner', undefined, job.createdAt),
    ).toBe(true);
    await expect(recover(store)).rejects.toMatchObject({ reason: 'source_missing' });
    expect((await store.getJob('conversation'))?.createdAt).toBe(job.createdAt);
  });

  test('a legacy source reports protocol_mismatch without upgrading or deleting it', async () => {
    const job = await park(store, 1);
    await expect(recover(store)).rejects.toMatchObject({ reason: 'protocol_mismatch' });
    expect((await store.getJob('conversation'))?.createdAt).toBe(job.createdAt);
    const parked = await store.claimParkedSteersDetailed('conversation', 'owner', undefined, 2);
    expect(parked?.generationProtocolVersion).toBe(1);
  });

  test.each([
    { ...proof, text: 'different words' },
    { ...proof, quotes: ['local quote never accepted by the source'] },
    { ...proof, fileIds: ['extra-file'] },
  ])('a genuine mismatch preserves the source and predecessor', async (payload) => {
    const job = await park(store);
    await expect(recover(store, payload)).rejects.toMatchObject({ reason: 'payload_mismatch' });
    expect((await store.getJob('conversation'))?.createdAt).toBe(job.createdAt);
    const parked = await store.claimParkedSteersDetailed('conversation', 'owner', undefined, 2);
    expect(JSON.parse(parked!.payload).steers).toEqual([source]);
  });

  test('a foreign recovery cannot replace the owner or consume its source', async () => {
    const job = await park(store);
    await expect(
      store.createJob(
        'conversation',
        'another-owner',
        'conversation',
        undefined,
        { generationProtocolVersion: 2 },
        'source',
        undefined,
        undefined,
        undefined,
        proof,
      ),
    ).rejects.toMatchObject({ reason: 'owner_mismatch' });
    expect((await store.getJob('conversation'))?.createdAt).toBe(job.createdAt);
    expect(
      JSON.parse(
        (await store.claimParkedSteersDetailed('conversation', 'owner', undefined, 2))!.payload,
      ).steers,
    ).toEqual([source]);
  });

  test('missing proof reports invalid_payload before a mutation', async () => {
    await expect(
      store.createJob(
        'conversation',
        'owner',
        'conversation',
        undefined,
        { generationProtocolVersion: 2 },
        'source',
      ),
    ).rejects.toMatchObject({ reason: 'invalid_payload' });
    expect(await store.getJob('conversation')).toBeNull();
  });

  test.each([
    'source_missing',
    'protocol_mismatch',
    'owner_mismatch',
    'invalid_payload',
    'payload_mismatch',
  ] as const)(
    'preserves the legacy wire code and records a payload-free diagnostic (%s)',
    (reason) => {
      const warning = jest.spyOn(logger, 'warn').mockImplementation();
      expect(
        getSteerRecoveryFailure(new RecoveredSteerPayloadMismatchError(reason), {
          conversationId: 'conversation',
          streamId: 'stream',
          recoveredSteerId: 'source',
        }),
      ).toMatchObject({ code: 'RECOVERY_PAYLOAD_MISMATCH', reason });
      expect(warning).toHaveBeenCalledWith('[SteerRecovery] Recovery rejected', {
        conversationId: 'conversation',
        streamId: 'stream',
        recoveredSteerId: 'source',
        reason,
      });
    },
  );
});
