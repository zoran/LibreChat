/** Upload resource evidence and policy; persistence and fencing belong to UploadRepository. */
import type { UploadLimits } from 'librechat-data-provider';
export const uploadSignals = [
  'cpu',
  'cpu_psi',
  'memory_psi',
  'io_psi',
  'memory',
  'nic',
  'latency',
  'temp',
] as const;
export type UploadSignal = (typeof uploadSignals)[number];
export type UploadControlMode = 'normal' | 'fallback' | 'blocked';
export type UploadControlReason =
  | 'startup'
  | 'healthy'
  | 'pressure'
  | 'warming'
  | 'stale'
  | 'missing'
  | 'invalid'
  | 'hard_guard'
  | 'durability'
  | 'hold';
export interface UploadClock {
  nowMs: number;
  monotonicMs: number;
}
export interface UploadResourceKey {
  node: string;
  pool: string;
  signal: UploadSignal;
}
export interface UploadResourceSample extends UploadResourceKey {
  value: number;
  sourceTimeMs: number;
  evaluatedTimeMs: number;
  rawSamples: number;
  resets: number;
  healthy: boolean;
  /** Actual service calls in the histogram window, distinct from scrape support. */
  observations?: number;
}
export interface UploadResourceSnapshot {
  observer: string;
  receivedAt: UploadClock;
  expiresAtMs: number;
  expiresMonotonicMs: number;
  samples: readonly UploadResourceSample[];
}
export interface UploadHardGuards {
  safe: boolean;
  durability: 'safe' | 'unsafe' | 'unknown';
}
export interface UploadControllerState {
  limits: UploadLimits;
  mode: UploadControlMode;
  reason: UploadControlReason;
  ewma: Record<string, number>;
  sourceTimes: Record<string, number>;
  highSamples: number;
  lowSamples: number;
  lastDecreaseMs: number;
  lastIncreaseMs: number;
  lastMonotonicMs: number;
  lastWallMs: number;
  increaseDimension: 'permits' | 'rate';
}
export interface UploadControlInput extends UploadClock {
  expected: readonly UploadResourceKey[];
  snapshots: readonly UploadResourceSnapshot[];
  hardGuards: UploadHardGuards;
}
export interface UploadControlDecision {
  mode: UploadControlMode;
  reason: UploadControlReason;
  limits: UploadLimits;
  sourceExpiresAtMs: number;
}
