import type { UploadControlInput, UploadResourceSnapshot, UploadControllerState } from './types';
import { advanceUploadController, createUploadControllerState } from './controller';

const start = 1800000000000;
const key = { node: 'cpu-1', pool: 'originals', signal: 'cpu' as const };
function input(seconds: number, value = 0.1): UploadControlInput {
  const nowMs = start + seconds * 1000;
  const snapshot: UploadResourceSnapshot = {
    observer: 'collector-1',
    receivedAt: { nowMs, monotonicMs: seconds * 1000 },
    expiresAtMs: nowMs + 70000,
    expiresMonotonicMs: seconds * 1000 + 70000,
    samples: [
      {
        ...key,
        value,
        sourceTimeMs: nowMs,
        evaluatedTimeMs: nowMs,
        rawSamples: 4,
        resets: 0,
        healthy: true,
      },
    ],
  };
  return {
    nowMs,
    monotonicMs: seconds * 1000,
    expected: [key],
    snapshots: [snapshot],
    hardGuards: { safe: true, durability: 'safe' },
  };
}
function elevated(): UploadControllerState {
  return {
    ...createUploadControllerState({ nowMs: start, monotonicMs: 0 }),
    mode: 'normal',
    limits: { transferPermits: 6, processingPermits: 3, transferBytesPerSecond: 8388608 },
  };
}

describe('upload policy safety and recovery', () => {
  it('blocks independently of healthy telemetry when durability is unknown', () => {
    const data = input(30);
    data.hardGuards.durability = 'unknown';
    expect(advanceUploadController(elevated(), data).decision).toMatchObject({
      mode: 'blocked',
      limits: { transferPermits: 0, processingPermits: 0, transferBytesPerSecond: 0 },
    });
  });
  it('halves after two distinct high samples and never averages away a hot host', () => {
    let state = elevated();
    for (const seconds of [30, 60]) {
      const data = input(seconds, 0.95);
      const other = { ...key, node: 'cpu-2' };
      data.expected = [key, other];
      data.snapshots = [
        {
          ...data.snapshots[0],
          samples: [
            ...data.snapshots[0].samples,
            { ...data.snapshots[0].samples[0], ...other, value: 0 },
          ],
        },
      ];
      state = advanceUploadController(state, data).state;
    }
    expect(state.limits).toEqual({
      transferPermits: 3,
      processingPermits: 1,
      transferBytesPerSecond: 4194304,
    });
  });
  it('repeated timestamps cannot manufacture healthy recovery', () => {
    let state = createUploadControllerState({ nowMs: start, monotonicMs: 0 });
    const data = input(30);
    for (let attempt = 0; attempt < 5; attempt++)
      state = advanceUploadController(state, data).state;
    expect(state.limits.transferPermits).toBe(1);
    expect(state.lowSamples).toBe(1);
  });
  it('grows only after distinct healthy observations and cooldown, without doubling collectors', () => {
    let state = createUploadControllerState({ nowMs: start, monotonicMs: 0 });
    for (const seconds of [30, 60, 90]) {
      const data = input(seconds);
      data.snapshots = [data.snapshots[0], { ...data.snapshots[0], observer: 'collector-2' }];
      state = advanceUploadController(state, data).state;
    }
    expect(state.limits).toEqual({
      transferPermits: 2,
      processingPermits: 2,
      transferBytesPerSecond: 1048576,
    });
  });
  it('treats a freshly evaluated rule with expired raw sources as fallback', () => {
    const data = input(90);
    data.snapshots[0].samples[0].sourceTimeMs = start;
    expect(advanceUploadController(elevated(), data).decision).toMatchObject({
      mode: 'fallback',
      reason: 'stale',
      limits: { transferPermits: 1, transferBytesPerSecond: 1048576 },
    });
  });
  it('rejects missing participants and a backwards monotonic clock', () => {
    const data = input(30);
    data.expected = [key, { ...key, node: 'cpu-2' }];
    expect(advanceUploadController(elevated(), data).decision.mode).toBe('fallback');
    data.monotonicMs = -1;
    expect(advanceUploadController(elevated(), data).decision.reason).toBe('invalid');
  });
  it('keeps policy inputs immutable and ignores recovery credit after a counter reset', () => {
    const original = elevated();
    const before = JSON.stringify(original);
    const data = input(30);
    data.snapshots[0].samples[0].resets = 1;
    expect(advanceUploadController(original, data).decision.mode).toBe('fallback');
    expect(JSON.stringify(original)).toBe(before);
  });
  it('takes the restrictive simultaneous collector view and rejects regressed source time', () => {
    let state = elevated();
    for (const seconds of [30, 60]) {
      const data = input(seconds, 0.95);
      data.snapshots = [
        data.snapshots[0],
        {
          ...data.snapshots[0],
          observer: 'collector-2',
          samples: [{ ...data.snapshots[0].samples[0], value: 0.1 }],
        },
      ];
      state = advanceUploadController(state, data).state;
    }
    expect(state.limits.transferPermits).toBe(3);
    const data = input(90);
    data.snapshots[0].samples[0].sourceTimeMs = start + 30000;
    expect(advanceUploadController(state, data).decision.reason).toBe('invalid');
  });
  it('requires real service observations and rejects clock steps without prolonging validity', () => {
    const data = input(30);
    data.expected = [{ ...key, signal: 'latency' }];
    data.snapshots = [
      {
        ...data.snapshots[0],
        samples: [{ ...data.snapshots[0].samples[0], signal: 'latency', observations: 19 }],
      },
    ];
    expect(advanceUploadController(elevated(), data).decision.reason).toBe('warming');
    data.monotonicMs = 10000;
    expect(advanceUploadController(elevated(), data).decision.reason).toBe('invalid');
  });
});
