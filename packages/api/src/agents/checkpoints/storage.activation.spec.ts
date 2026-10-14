import mongoose from 'mongoose';
import { createHash } from 'node:crypto';
import {
  CHECKPOINT_STORAGE_COLLECTION,
  checkpointStorageKey,
  inspectInitialCheckpointPopulation,
} from './storage';
import { resolveCheckpointerConfig } from './config';

const currentConfig = resolveCheckpointerConfig({
  type: 'mongo',
  checkpointCollectionName: 'current_checkpoints',
  checkpointWritesCollectionName: 'current_checkpoint_writes',
});
const options = () => ({
  originalDeadline: new Date(Date.now() + 60_000).toISOString(),
  targetBindingSha256: 'a'.repeat(64),
  currentConfig,
});
const owner = `lcg:v2:${'b'.repeat(64)}:`;
const retained = {
  type: 'mongo' as const,
  checkpointCollectionName: 'old_checkpoints',
  checkpointWritesCollectionName: 'old_checkpoint_writes',
};
const record = () => ({
  _id: `${owner}${checkpointStorageKey(retained)}`,
  owner,
  storage: retained,
});

describe('metadata-only checkpoint admission inventory', () => {
  let calls: Array<{ name: string; pipeline: unknown[]; options: Record<string, unknown> }>;
  let rows: Record<string, unknown[]>;
  let originalDb: unknown;
  let originalReady: PropertyDescriptor | undefined;
  beforeEach(() => {
    calls = [];
    rows = {};
    originalDb = mongoose.connection.db;
    originalReady = Object.getOwnPropertyDescriptor(mongoose.connection, 'readyState');
    Object.defineProperty(mongoose.connection, 'db', {
      configurable: true,
      writable: true,
      value: {
        collection: (name: string) => ({
          aggregate: (pipeline: unknown[], opts: Record<string, unknown>) => {
            calls.push({ name, pipeline, options: opts });
            return { toArray: async () => rows[name] ?? [] };
          },
        }),
      },
    });
    Object.defineProperty(mongoose.connection, 'readyState', {
      configurable: true,
      value: 1,
    });
  });
  afterEach(() => {
    Object.defineProperty(mongoose.connection, 'db', {
      configurable: true,
      writable: true,
      value: originalDb,
    });
    if (originalReady) {
      Object.defineProperty(mongoose.connection, 'readyState', originalReady);
    } else {
      Reflect.deleteProperty(mongoose.connection, 'readyState');
    }
  });

  it('checks default, actual current and retained descriptors without initializing a saver', async () => {
    rows[CHECKPOINT_STORAGE_COLLECTION] = [{ record: record() }];
    const result = await inspectInitialCheckpointPopulation(options());
    expect(result).toMatchObject({
      schema: 1,
      owner: 'agent-checkpoints',
      complete: true,
      saturatedCounts: { recoveryCopies: 0 },
      targetBindingSha256: 'a'.repeat(64),
    });
    expect(calls.map((call) => call.name)).toEqual(
      expect.arrayContaining([
        'agent_checkpoints',
        'agent_checkpoint_writes',
        'current_checkpoints',
        'current_checkpoint_writes',
        'old_checkpoints',
        'old_checkpoint_writes',
      ]),
    );
    const normalized = Object.fromEntries(
      Object.entries(currentConfig).sort(([a], [b]) => a.localeCompare(b)),
    );
    expect(result.configurationSha256).toBe(
      createHash('sha256').update(JSON.stringify(normalized)).digest('hex'),
    );
    expect(result.evidenceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain(owner);
    for (const call of calls) {
      expect(call.options.maxTimeMS).toBeGreaterThan(0);
      expect(call.options.maxTimeMS).toBeLessThanOrEqual(2000);
      expect(JSON.stringify(call.pipeline)).not.toMatch(/\$out|\$merge|checkpoint.*\$binary/);
    }
  });

  it.each(['agent_checkpoints', 'current_checkpoint_writes', 'old_checkpoints'])(
    'blocks an opaque existing row in %s without loading its binary payload',
    async (name) => {
      rows[CHECKPOINT_STORAGE_COLLECTION] = [{ record: record() }];
      rows[name] = [{ present: 1 }];
      const result = await inspectInitialCheckpointPopulation(options());
      expect(result).toMatchObject({ complete: false, saturatedCounts: { recoveryCopies: 1 } });
      const query = calls.find((call) => call.name === name)!;
      expect(query.pipeline).toContainEqual({ $limit: 1 });
      expect(query.pipeline).toContainEqual({ $project: { _id: 0, present: { $literal: 1 } } });
    },
  );

  it.each(['invalid', 'overflow', 'unknown-type'])(
    'fails on %s registry evidence, never empty',
    async (kind) => {
      rows[CHECKPOINT_STORAGE_COLLECTION] =
        kind === 'overflow'
          ? Array.from({ length: 257 }, () => ({ record: record() }))
          : [
              {
                record:
                  kind === 'invalid'
                    ? { invalid: true }
                    : { ...record(), storage: { ...retained, type: 'unknown' } },
              },
            ];
      await expect(inspectInitialCheckpointPopulation(options())).rejects.toThrow(/inventory/i);
    },
  );

  it('requires the actual current config and a live bounded deadline', async () => {
    await expect(
      inspectInitialCheckpointPopulation({ ...options(), currentConfig: undefined as never }),
    ).rejects.toThrow(/inventory/i);
    await expect(
      inspectInitialCheckpointPopulation({
        ...options(),
        originalDeadline: new Date(Date.now() - 1).toISOString(),
      }),
    ).rejects.toThrow(/inventory/i);
    expect(calls).toEqual([]);
  });

  it('uses the common canonical ISO-Z timestamp DTO without changing the original deadline', async () => {
    const input = options();
    const before = Date.now();
    const result = await inspectInitialCheckpointPopulation(input);
    expect(result.originalDeadline).toBe(input.originalDeadline);
    for (const field of ['originalDeadline', 'observedFrom', 'observedThrough'] as const) {
      const value = result[field];
      expect(typeof value).toBe('string');
      expect(value).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      expect(new Date(Date.parse(value)).toISOString()).toBe(value);
    }
    expect(Date.parse(result.observedFrom)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(result.observedThrough)).toBeGreaterThanOrEqual(
      Date.parse(result.observedFrom),
    );
    expect(Date.parse(result.observedThrough)).toBeLessThan(Date.parse(input.originalDeadline));
  });

  it('rejects numeric, coerced and noncanonical deadline inputs before accessing Mongo', async () => {
    for (const originalDeadline of [
      Date.now() + 60_000,
      new Date(Date.now() + 60_000),
      { toString: () => options().originalDeadline },
      '2099-01-01T00:00:00Z',
      '2099-01-01T00:00:00.000+00:00',
      '2099-02-30T00:00:00.000Z',
    ]) {
      await expect(
        inspectInitialCheckpointPopulation({
          ...options(),
          originalDeadline: originalDeadline as never,
        }),
      ).rejects.toThrow(/inventory/i);
    }
    expect(calls).toEqual([]);
  });
});
