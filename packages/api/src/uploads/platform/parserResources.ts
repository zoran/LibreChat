/** Parser-local resource accounting on the existing Unix boundary; never a stop receipt. */
import { request } from 'node:http';
import { performance } from 'node:perf_hooks';
import type { UploadMemoryObservation } from './local';
import type { UploadClock } from '../control/types';
import {
  createUploadLocalSampler,
  freshLocal,
  measureUploadDirectory,
  measureUploadMemory,
  LOCAL_POOL_BYTES,
  LOCAL_FLOOR_BYTES,
  PARSER_MEMORY_RESERVATION,
  PARSER_SCRATCH_RESERVATION,
} from './local';
import { assessUploadLocalResources } from '../control/hardGuards';

export interface UploadParserResources {
  schema: 1;
  instanceId: string;
  observedAtMs: number;
  active: boolean;
  memory: { currentBytes: number; limitBytes: number; reservedBytes: number };
  scratch: {
    usedBytes: number;
    reservedBytes: number;
    freeBytes: number;
    freeInodes: number;
    capacityBytes: number;
  };
}
export interface UploadParserResourceOwner {
  current(): UploadParserResources | undefined;
  start(): Promise<void>;
  claim(): void;
  release(): void;
  safe(prospective?: boolean): boolean;
  close(): void;
}

export function parserResourcesSafe(value: UploadParserResources, prospective: boolean): boolean {
  if (prospective && value.active) return false;
  return assessUploadLocalResources({
    memory: {
      ...value.memory,
      reservedBytes: value.memory.reservedBytes + (prospective ? PARSER_MEMORY_RESERVATION : 0),
    },
    mounts: [
      {
        slot: 'parser',
        ...value.scratch,
        requiredBytes: prospective ? PARSER_SCRATCH_RESERVATION : 0,
        floorBytes: LOCAL_FLOOR_BYTES,
      },
    ],
  }).safe;
}

export function createUploadParserResourceOwner(options: {
  scratchRoot: string;
  cgroupDirectory: string;
  instanceId: string;
  clock?: () => UploadClock;
}): UploadParserResourceOwner {
  const clock = options.clock ?? (() => ({ nowMs: Date.now(), monotonicMs: performance.now() }));
  let memory: { observedAtMs: number; value: UploadMemoryObservation } | undefined;
  let baseline: { memoryBytes: number; scratchBytes: number } | undefined;
  const sampler = createUploadLocalSampler({
    root: options.scratchRoot,
    clock,
    measure: async (root, now) => {
      const disk = await measureUploadDirectory(root, now);
      const measured = await measureUploadMemory(options.cgroupDirectory);
      memory = { observedAtMs: disk.observedAtMs, value: measured };
      return disk;
    },
  });
  function current(): UploadParserResources | undefined {
    const disk = sampler.current();
    if (!disk || !memory || memory.observedAtMs !== disk.observedAtMs) return undefined;
    return {
      schema: 1,
      instanceId: options.instanceId,
      observedAtMs: disk.observedAtMs,
      active: Boolean(baseline),
      memory: {
        ...memory.value,
        reservedBytes: baseline
          ? Math.max(
              0,
              PARSER_MEMORY_RESERVATION -
                Math.max(0, memory.value.currentBytes - baseline.memoryBytes),
            )
          : 0,
      },
      scratch: {
        usedBytes: disk.usedBytes,
        freeBytes: disk.freeBytes,
        freeInodes: disk.freeInodes,
        capacityBytes: LOCAL_POOL_BYTES,
        reservedBytes: baseline
          ? Math.max(
              0,
              PARSER_SCRATCH_RESERVATION - Math.max(0, disk.usedBytes - baseline.scratchBytes),
            )
          : 0,
      },
    };
  }
  return {
    current,
    start: () => sampler.start(),
    claim(): void {
      const value = current();
      if (!value || !parserResourcesSafe(value, true))
        throw new Error('parser_resources_unavailable');
      baseline = { memoryBytes: value.memory.currentBytes, scratchBytes: value.scratch.usedBytes };
    },
    release(): void {
      baseline = undefined;
    },
    safe(prospective = false): boolean {
      const value = current();
      return Boolean(value && parserResourcesSafe(value, prospective));
    },
    close(): void {
      sampler.close();
    },
  };
}

/** Strict parser reply decoder; remote timestamps are not replaced with receipt time. */
export function decodeParserResources(value: unknown, nowMs: number): UploadParserResources {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid_parser_resources');
  const raw = value as UploadParserResources;
  const counts = (input: unknown, keys: readonly string[]): boolean =>
    Boolean(
      input &&
        typeof input === 'object' &&
        !Array.isArray(input) &&
        Object.keys(input).length === keys.length &&
        keys.every((key) => {
          const item = (input as Record<string, unknown>)[key];
          return typeof item === 'number' && Number.isSafeInteger(item) && item >= 0;
        }),
    );
  if (
    raw.schema !== 1 ||
    typeof raw.instanceId !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(raw.instanceId) ||
    typeof raw.active !== 'boolean' ||
    !Number.isSafeInteger(raw.observedAtMs) ||
    raw.observedAtMs > nowMs ||
    nowMs - raw.observedAtMs >= 10_000 ||
    !raw.memory ||
    !raw.scratch ||
    !counts(raw.memory, ['currentBytes', 'limitBytes', 'reservedBytes']) ||
    !counts(raw.scratch, [
      'usedBytes',
      'reservedBytes',
      'freeBytes',
      'freeInodes',
      'capacityBytes',
    ]) ||
    raw.scratch.capacityBytes !== LOCAL_POOL_BYTES ||
    raw.memory.reservedBytes > PARSER_MEMORY_RESERVATION ||
    raw.scratch.reservedBytes > PARSER_SCRATCH_RESERVATION
  )
    throw new Error('invalid_parser_resources');
  return raw;
}

export interface UploadParserResourceClient {
  current(): UploadParserResources | undefined;
  refresh(): Promise<void>;
  start(): Promise<void>;
  close(): Promise<void>;
}
export function createUploadParserResourceClient(options: {
  socketPath: string;
  clock: () => UploadClock;
}): UploadParserResourceClient {
  let cached:
    | { observedAtMs: number; observedMonotonicMs: number; value: UploadParserResources }
    | undefined;
  let flight: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let abort: AbortController | undefined;
  let closed = false;
  function refresh(): Promise<void> {
    if (closed) return Promise.resolve();
    if (flight) return flight;
    const started = options.clock();
    const controller = new AbortController();
    abort = controller;
    flight = new Promise<void>((resolve) => {
      let finished = false;
      const finish = (value?: UploadParserResources) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        if (!closed) {
          const end = options.clock();
          if (
            value &&
            !controller.signal.aborted &&
            end.monotonicMs - started.monotonicMs < 1_000 &&
            Math.abs(end.nowMs - started.nowMs - (end.monotonicMs - started.monotonicMs)) <= 1_000
          ) {
            const observedMonotonicMs = end.monotonicMs - (end.nowMs - value.observedAtMs);
            cached = {
              observedAtMs: value.observedAtMs,
              observedMonotonicMs:
                cached?.observedAtMs === value.observedAtMs
                  ? Math.min(cached.observedMonotonicMs, observedMonotonicMs)
                  : observedMonotonicMs,
              value,
            };
          } else cached = undefined;
        }
        resolve();
      };
      const timeout = setTimeout(() => {
        controller.abort();
        finish();
      }, 1_000);
      timeout.unref();
      const req = request(
        {
          socketPath: options.socketPath,
          path: '/resources',
          method: 'GET',
          signal: controller.signal,
          headers: { accept: 'application/json', connection: 'close' },
        },
        (res) => {
          if (res.statusCode !== 200 || res.headers['content-type'] !== 'application/json') {
            res.destroy();
            finish();
            return;
          }
          let bytes = 0;
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 4096) {
              controller.abort();
              finish();
            } else chunks.push(chunk);
          });
          res.once('error', () => finish());
          res.once('aborted', () => finish());
          res.once('end', () => {
            try {
              finish(
                decodeParserResources(
                  JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')),
                  options.clock().nowMs,
                ),
              );
            } catch {
              finish();
            }
          });
        },
      );
      req.once('error', () => finish());
      req.end();
    }).finally(() => {
      flight = undefined;
      abort = undefined;
    });
    return flight;
  }
  return {
    current(): UploadParserResources | undefined {
      return cached && freshLocal(cached, options.clock()) ? cached.value : undefined;
    },
    refresh,
    async start(): Promise<void> {
      if (closed || timer) return;
      await refresh();
      if (!closed && !timer) {
        timer = setInterval(() => {
          void refresh();
        }, 5_000);
        timer.unref();
      }
    },
    async close(): Promise<void> {
      closed = true;
      clearInterval(timer);
      abort?.abort();
      await flight;
      cached = undefined;
    },
  };
}
