/** Pure policy only: callers must publish through the current fenced repository lease. */
import type { UploadLimits } from 'librechat-data-provider';
import type {
  UploadClock,
  UploadControllerState,
  UploadControlInput,
  UploadControlDecision,
  UploadControlReason,
  UploadResourceKey,
  UploadResourceSample,
  UploadResourceSnapshot,
  UploadSignal,
} from './types';

const MiB = 1048576;
export const UPLOAD_SOURCE_MAX_AGE_MS = 70000;
const fallback: Readonly<UploadLimits> = {
  transferPermits: 1,
  processingPermits: 1,
  transferBytesPerSecond: MiB,
};
const ceiling: Readonly<UploadLimits> = {
  transferPermits: 6,
  processingPermits: 3,
  transferBytesPerSecond: 8 * MiB,
};
const thresholds: Record<UploadSignal, { high: number; low: number; lowerIsWorse?: boolean }> = {
  cpu: { high: 0.85, low: 0.6 },
  cpu_psi: { high: 0.2, low: 0.05 },
  memory_psi: { high: 0.05, low: 0.01 },
  io_psi: { high: 0.2, low: 0.05 },
  memory: { high: 0.15, low: 0.25, lowerIsWorse: true },
  nic: { high: 0.75, low: 0.5 },
  latency: { high: 2, low: 0.5 },
  temp: { high: 0.8, low: 0.6 },
};
export function uploadResourceKey(key: UploadResourceKey): string {
  return JSON.stringify([key.node, key.pool, key.signal]);
}
function bounded(limits: UploadLimits): UploadLimits {
  return {
    transferPermits: Math.max(
      1,
      Math.min(ceiling.transferPermits, Math.floor(limits.transferPermits)),
    ),
    processingPermits: Math.max(
      1,
      Math.min(ceiling.processingPermits, Math.floor(limits.processingPermits)),
    ),
    transferBytesPerSecond: Math.max(
      MiB,
      Math.min(ceiling.transferBytesPerSecond, Math.floor(limits.transferBytesPerSecond)),
    ),
  };
}
function view(
  input: UploadControlInput,
  snapshot: UploadResourceSnapshot,
): { samples?: Map<string, UploadResourceSample>; reason: UploadControlReason; expires: number } {
  const times = [
    snapshot.receivedAt.nowMs,
    snapshot.receivedAt.monotonicMs,
    snapshot.expiresAtMs,
    snapshot.expiresMonotonicMs,
  ];
  if (
    times.some((n) => !Number.isFinite(n)) ||
    snapshot.receivedAt.nowMs > input.nowMs ||
    snapshot.receivedAt.monotonicMs > input.monotonicMs
  )
    return { reason: 'invalid', expires: input.nowMs };
  if (snapshot.expiresAtMs <= input.nowMs || snapshot.expiresMonotonicMs <= input.monotonicMs)
    return { reason: 'stale', expires: input.nowMs };
  const samples = new Map<string, UploadResourceSample>();
  const expected = new Set(input.expected.map(uploadResourceKey));
  let expires = Math.min(
    snapshot.expiresAtMs,
    input.nowMs + snapshot.expiresMonotonicMs - input.monotonicMs,
  );
  for (const sample of snapshot.samples) {
    const key = uploadResourceKey(sample);
    if (
      !expected.has(key) ||
      samples.has(key) ||
      !thresholds[sample.signal] ||
      [
        sample.value,
        sample.sourceTimeMs,
        sample.evaluatedTimeMs,
        sample.rawSamples,
        sample.resets,
      ].some((n) => !Number.isFinite(n)) ||
      sample.value < 0 ||
      sample.sourceTimeMs > input.nowMs ||
      sample.evaluatedTimeMs > input.nowMs ||
      sample.sourceTimeMs > sample.evaluatedTimeMs ||
      sample.resets < 0 ||
      !Number.isInteger(sample.rawSamples)
    )
      return { reason: 'invalid', expires: input.nowMs };
    if (
      input.nowMs - sample.sourceTimeMs >= UPLOAD_SOURCE_MAX_AGE_MS ||
      input.nowMs - sample.evaluatedTimeMs >= UPLOAD_SOURCE_MAX_AGE_MS
    )
      return { reason: 'stale', expires: input.nowMs };
    if (!sample.healthy) return { reason: 'missing', expires: input.nowMs };
    if (
      sample.resets > 0 ||
      sample.rawSamples < 4 ||
      (sample.signal === 'latency' &&
        (!Number.isFinite(sample.observations) || (sample.observations ?? 0) < 20))
    )
      return { reason: 'warming', expires: input.nowMs };
    expires = Math.min(expires, sample.sourceTimeMs + UPLOAD_SOURCE_MAX_AGE_MS);
    samples.set(key, sample);
  }
  return samples.size === expected.size
    ? { samples, reason: 'healthy', expires }
    : { reason: 'missing', expires: input.nowMs };
}

export function createUploadControllerState(clock: UploadClock): UploadControllerState {
  return {
    limits: { transferPermits: 1, processingPermits: 1, transferBytesPerSecond: 1048576 },
    mode: 'fallback',
    reason: 'startup',
    ewma: {},
    sourceTimes: {},
    highSamples: 0,
    lowSamples: 0,
    lastDecreaseMs: clock.monotonicMs,
    lastIncreaseMs: clock.monotonicMs,
    lastMonotonicMs: clock.monotonicMs,
    lastWallMs: clock.nowMs,
    increaseDimension: 'permits',
  };
}

export function advanceUploadController(
  state: UploadControllerState,
  input: UploadControlInput,
): { state: UploadControllerState; decision: UploadControlDecision } {
  const next = {
    ...state,
    limits: { ...state.limits },
    ewma: { ...state.ewma },
    sourceTimes: { ...state.sourceTimes },
  };
  const result = (expires: number) => ({
    state: next,
    decision: {
      mode: next.mode,
      reason: next.reason,
      limits: { ...next.limits },
      sourceExpiresAtMs: expires,
    },
  });
  const clamp = (reason: UploadControlReason, blocked = false) => {
    next.mode = blocked ? 'blocked' : 'fallback';
    next.reason = reason;
    next.limits = blocked
      ? { transferPermits: 0, processingPermits: 0, transferBytesPerSecond: 0 }
      : { ...fallback };
    next.highSamples = 0;
    next.lowSamples = 0;
    next.lastIncreaseMs = Number.isFinite(input.monotonicMs)
      ? Math.max(state.lastIncreaseMs, input.monotonicMs)
      : state.lastIncreaseMs;
    // No telemetry is needed for fallback; the repository separately rechecks hard gates.
    return result(Number.isFinite(input.nowMs) ? input.nowMs : 0);
  };
  if (!input.hardGuards.safe) return clamp('hard_guard', true);
  if (input.hardGuards.durability !== 'safe') return clamp('durability', true);
  if (
    ![input.nowMs, input.monotonicMs, ...Object.values(state.limits)].every(Number.isFinite) ||
    input.monotonicMs < state.lastMonotonicMs ||
    input.nowMs < state.lastWallMs ||
    Math.abs(input.nowMs - state.lastWallMs - (input.monotonicMs - state.lastMonotonicMs)) > 5000
  )
    return clamp('invalid');
  next.lastMonotonicMs = input.monotonicMs;
  next.lastWallMs = input.nowMs;
  if (
    !input.expected.length ||
    input.expected.length > 64 ||
    new Set(input.expected.map(uploadResourceKey)).size !== input.expected.length
  )
    return clamp('invalid');
  if (!input.snapshots.length || input.snapshots.length > 2) return clamp('missing');
  const views = input.snapshots.map((snapshot) => view(input, snapshot));
  const valid = views.filter((candidate) => candidate.samples !== undefined);
  if (!valid.length) return clamp(views[0]?.reason ?? 'missing');
  const recency = (candidate: (typeof valid)[number]) =>
    Math.min(...[...candidate.samples!.values()].map((sample) => sample.sourceTimeMs));
  const newest = Math.max(...valid.map(recency));
  const simultaneous = valid.filter((candidate) => newest - recency(candidate) <= 30000);
  const selected: UploadResourceSample[] = [];
  for (const key of input.expected) {
    const id = uploadResourceKey(key);
    const candidates = simultaneous.map((candidate) => candidate.samples!.get(id)!);
    // Simultaneous collector disagreement is resolved per resource, never averaged.
    const worst = candidates.reduce((left, right) => {
      if (thresholds[key.signal].lowerIsWorse) return left.value < right.value ? left : right;
      return left.value > right.value ? left : right;
    });
    selected.push({
      ...worst,
      sourceTimeMs: Math.min(...candidates.map((sample) => sample.sourceTimeMs)),
    });
  }
  if (
    selected.some(
      (sample) => sample.sourceTimeMs < (state.sourceTimes[uploadResourceKey(sample)] ?? 0),
    )
  )
    return clamp('invalid');
  const distinct = selected.every(
    (sample) => sample.sourceTimeMs > (state.sourceTimes[uploadResourceKey(sample)] ?? 0),
  );
  for (const sample of selected) {
    const id = uploadResourceKey(sample);
    if (sample.sourceTimeMs > (state.sourceTimes[id] ?? 0)) {
      next.ewma[id] =
        state.ewma[id] === undefined ? sample.value : 0.25 * sample.value + 0.75 * state.ewma[id];
      next.sourceTimes[id] = sample.sourceTimeMs;
    }
  }
  const high = selected.some((sample) => {
    const t = thresholds[sample.signal];
    const value = next.ewma[uploadResourceKey(sample)];
    return t.lowerIsWorse ? value <= t.high : value >= t.high;
  });
  const low = selected.every((sample) => {
    const t = thresholds[sample.signal];
    const value = next.ewma[uploadResourceKey(sample)];
    return t.lowerIsWorse ? value >= t.low : value <= t.low;
  });
  next.limits = bounded(next.limits);
  next.mode = 'normal';
  next.reason = 'hold';
  if (distinct) {
    next.highSamples = high ? Math.min(2, state.highSamples + 1) : 0;
    next.lowSamples = low ? Math.min(3, state.lowSamples + 1) : 0;
    if (next.highSamples >= 2 && input.monotonicMs - state.lastDecreaseMs >= 30000) {
      next.limits = bounded({
        transferPermits: Math.floor(next.limits.transferPermits / 2),
        processingPermits: Math.floor(next.limits.processingPermits / 2),
        transferBytesPerSecond: Math.floor(next.limits.transferBytesPerSecond / 2),
      });
      next.reason = 'pressure';
      next.lastDecreaseMs = input.monotonicMs;
      next.highSamples = 0;
      next.lowSamples = 0;
    } else if (
      next.lowSamples >= 3 &&
      input.monotonicMs - state.lastIncreaseMs >= 90000 &&
      input.monotonicMs - state.lastDecreaseMs >= 90000
    ) {
      const permits =
        state.increaseDimension === 'permits' &&
        next.limits.transferPermits < ceiling.transferPermits;
      next.limits = bounded({
        transferPermits: next.limits.transferPermits + (permits ? 1 : 0),
        processingPermits: next.limits.processingPermits + 1,
        transferBytesPerSecond: next.limits.transferBytesPerSecond + (permits ? 0 : MiB),
      });
      next.increaseDimension = permits ? 'rate' : 'permits';
      next.reason = 'healthy';
      next.lastIncreaseMs = input.monotonicMs;
      next.lowSamples = 0;
    }
  }
  return result(Math.min(...simultaneous.map((candidate) => candidate.expires)));
}
