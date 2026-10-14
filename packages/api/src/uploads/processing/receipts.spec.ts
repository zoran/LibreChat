import { ParserReceipts } from './receipts';

describe('per-attempt parser fences', () => {
  let clock: number;
  let monotonic: number;
  const registry = (capacity = 256) =>
    new ParserReceipts({
      wallMs: 100,
      retentionMs: 1000,
      capacity,
      now: () => clock,
      monotonic: () => monotonic,
    });
  beforeEach(() => {
    clock = 1_000;
    monotonic = 10;
  });
  it('prepare is inert and exact replay returns the same execution receipt', () => {
    const receipts = registry();
    const execution = receipts.prepare('op.1', 'text/plain');
    expect(receipts.find(execution)?.state).toBe('prepared');
    expect(receipts.prepare('op.1', 'text/plain')).toEqual(execution);
  });
  it('a before-dispatch cancellation fences a delayed execute', () => {
    const receipts = registry();
    const execution = receipts.prepare('op.1', 'text/plain');
    receipts.fence(receipts.find(execution)!);
    receipts.finish(receipts.find(execution)!, true);
    expect(receipts.start(execution)).toBeUndefined();
    expect(() => receipts.prepare('op.1', 'text/plain')).toThrow();
  });
  it('a running attempt can start only once and its active fence cannot be evicted', () => {
    const receipts = registry(1);
    const execution = receipts.prepare('op.1', 'text/plain');
    const record = receipts.start(execution)!;
    expect(receipts.start(execution)).toBeUndefined();
    receipts.fence(record);
    clock += 10_000;
    monotonic += 10_000;
    expect(receipts.find(execution)).toBe(record);
    expect(() => receipts.prepare('op.2', 'text/plain')).toThrow();
  });
  it('a restarted or evicted identity is unknown, never a stopped proof', () => {
    const receipts = registry();
    const execution = receipts.prepare('op.1', 'text/plain');
    expect(registry().find(execution)).toBeUndefined();
    receipts.finish(receipts.find(execution)!, true);
    monotonic += 1001;
    expect(receipts.find(execution)).toBeUndefined();
    expect(receipts.start(execution)).toBeUndefined();
  });
  it('does not evict an unexpired receipt to admit more attempts', () => {
    const receipts = registry(1);
    receipts.prepare('op.1', 'text/plain');
    expect(() => receipts.prepare('op.2', 'text/plain')).toThrow();
  });
  it('wall-clock rollback cannot extend the execution deadline', () => {
    const receipts = registry();
    const execution = receipts.prepare('op.1', 'text/plain');
    clock -= 100_000;
    monotonic += 101;
    expect(receipts.start(execution)).toBeUndefined();
  });
  it('changed expiry or foreign incarnation cannot impersonate the prepared attempt', () => {
    const receipts = registry();
    const execution = receipts.prepare('op.1', 'text/plain');
    expect(receipts.find({ ...execution, instanceId: 'other' })).toBeUndefined();
    expect(
      receipts.find({ ...execution, expiresAt: new Date(clock + 1_000).toISOString() }),
    ).toBeUndefined();
  });
});
