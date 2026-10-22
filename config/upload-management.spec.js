/** Operator boundary tests use finite synthetic ports; no database, Redis, file or HTTP actor. */
'use strict';

const { Readable, PassThrough, Writable } = require('node:stream');
const {
  INPUT_LIMIT,
  readEnvelope,
  validateEnvelope,
  runActivation,
  main,
  canonical,
  digest,
} = require('./upload-management');
// Keep the real public contract loaded before native adapter tests install filesystem doubles.
const {
  RedisJobStore,
  parseUploadActivationGatewayContext,
  validateUploadActivationGateways,
} = require('@librechat/api/upload-activation');

const GATEWAYS = ['https://current-a.example:8333', 'https://current-b.example:8333'];
const GATEWAY_CONTEXT = JSON.stringify(GATEWAYS);
const GATEWAY_ENV = { CORTEX_UPLOAD_ACTIVATION_STORAGE_GATEWAYS: GATEWAY_CONTEXT };

const NOW = Date.parse('2026-10-14T00:10:00.000Z');
const DEADLINE = new Date(NOW + 120_000).toISOString();
const TARGET = {
  sourceRevision: 'a'.repeat(40),
  imageDigest: `sha256:${'b'.repeat(64)}`,
  namespaceUid: '3c1fae6a-886a-4acb-a13f-5cc7fc66c79c',
  mongoReplicaSet: 'cortex-rs',
  mongoDatabase: 'LibreChat',
  storageDeploymentId: 'deployment-test',
  storageStoreId: 'store-test',
  bucket: 'cortex-managed-uploads',
  coordination: { sentinelName: 'cortex', database: 0, keyPrefix: 'cortex::' },
};
const ZERO = { originalBytes: 0, objectBytes: 0, textBytes: 0, recordBytes: 0, bundles: 0 };
// Match stdin JSON objects in this realm; Jest exposes Node's host-realm structuredClone.
const cloneJson = (value) => JSON.parse(JSON.stringify(value));
const request = () => ({
  schema: 1,
  action: 'prepare',
  target: cloneJson(TARGET),
  originalDeadline: DEADLINE,
});
const snapshot = () => ({
  storeId: 'b3452f80-3c50-457c-a9e1-a4b71f4bc953',
  revision: 12,
  observedAt: new Date(NOW).toISOString(),
  ledgerTotals: { ...ZERO },
  baseline: { ...ZERO },
  initialInventory: { operations: 0, files: 0, sourceMessages: 0 },
});
const CONFIG = {
  type: 'mongo',
  ttlSeconds: 900,
  checkpointCollectionName: 'agent_checkpoints',
  checkpointWritesCollectionName: 'agent_checkpoint_writes',
};
const inspectionRequest = () => ({
  ...request(),
  action: 'inspect-checkpoint-indexes',
  historicalLineageSha256: 'c'.repeat(64),
});
const lineage = () => ({
  schema: 1,
  targetBindingSha256: digest(TARGET),
  configurationSha256: digest(CONFIG),
  evidenceSha256: inspectionRequest().historicalLineageSha256,
  stores: [],
});
function indexInspection() {
  const { saturatedCounts: _counts, ...common } = producer('agent-checkpoints');
  return {
    ...common,
    historicalLineageSha256: inspectionRequest().historicalLineageSha256,
    collections: ['checkpoint', 'pending'].map((role) => ({
      collection: `private_${role}`,
      role,
      rowCount: 3,
      malformedKeyRows: 0,
      duplicateGroups: 0,
      duplicateExcessRows: 0,
      indexes: [],
      indexStatus: 'verified',
    })),
  };
}
function producer(owner) {
  const value = {
    schema: 1,
    owner,
    originalDeadline: DEADLINE,
    observedFrom: new Date(NOW).toISOString(),
    observedThrough: new Date(NOW).toISOString(),
    targetBindingSha256: digest(TARGET),
    complete: true,
    evidenceSha256: 'e'.repeat(64),
  };
  if (owner === 'generation-stream')
    return {
      ...value,
      adapter: 'redis',
      saturatedCounts: { sourceJobs: 0, replayIntents: 0, recoveryCopies: 0 },
    };
  if (owner === 'agent-checkpoints')
    return {
      ...value,
      configurationSha256: digest(CONFIG),
      saturatedCounts: { recoveryCopies: 0 },
    };
  if (owner === 'object-storage')
    return {
      ...value,
      storageBindingSha256: 'd'.repeat(64),
      saturatedCounts: { objects: 0, multipartUploads: 0, versions: 0, deleteMarkers: 0 },
      measuredBytes: { objectBytes: 0, multipartBytes: 0, versionBytes: 0 },
      buckets: ['cortex-managed-uploads', 'cortex-qualification'],
      gateways: GATEWAYS.map((endpoint) => ({
        endpoint,
        versioning: { 'cortex-managed-uploads': 'Disabled', 'cortex-qualification': 'Disabled' },
      })),
    };
  return {
    ...value,
    saturatedCounts: { heldAttempts: 0, stagedCopies: 0, unresolvedWriters: 0 },
    measuredBytes: { heldBytes: 0, stagedBytes: 0 },
    volumeEvidenceSha256: 'f'.repeat(64),
    eligibleHosts: ['node-a', 'node-b'],
    podUids: ['9eab26c8-7b21-4e86-9d2c-29f5c1f942e0'],
  };
}
function activation() {
  return {
    ...request(),
    action: 'activate',
    preparation: {
      ...snapshot(),
      replayInventory: producer('generation-stream'),
      checkpointInventory: producer('agent-checkpoints'),
    },
    inventory: { storage: producer('object-storage'), staging: producer('librechat-staging') },
  };
}
function livePorts() {
  const runtime = {
    target: cloneJson(TARGET),
    configurationSha256: digest(CONFIG),
    repository: {
      initialize: jest.fn().mockResolvedValue(undefined),
      reconciliationSnapshot: jest.fn().mockImplementation(async () => snapshot()),
      activateReconciled: jest.fn().mockResolvedValue(undefined),
    },
    inspectReplay: jest.fn().mockImplementation(async () => producer('generation-stream')),
    inspectCheckpoints: jest.fn().mockImplementation(async () => producer('agent-checkpoints')),
    inspectCheckpointIndexes: jest.fn().mockImplementation(async () => indexInspection()),
    close: jest.fn().mockResolvedValue(undefined),
  };
  return {
    runtime,
    boundary: {
      storageGateways: GATEWAY_CONTEXT,
      now: () => NOW,
      open: jest.fn().mockResolvedValue(runtime),
    },
  };
}
function capture() {
  const chunks = [];
  return {
    output: new Writable({
      write(chunk, _encoding, done) {
        chunks.push(chunk);
        done();
      },
    }),
    text: () => Buffer.concat(chunks).toString('utf8'),
  };
}

describe('finite checkpoint index inspection', () => {
  test('the narrow source entry exports the existing inspector without opening clients or timers', () => {
    // Reuse the unchanged built Redis class so this config suite needs no API path-alias remapping.
    jest.doMock('../packages/api/src/stream/implementations/RedisJobStore', () => ({
      RedisJobStore,
    }));
    try {
      jest.isolateModules(() => {
        const mongoose = require('mongoose');
        const connect = jest.spyOn(mongoose, 'connect');
        const create = jest.spyOn(mongoose, 'createConnection');
        const interval = jest.spyOn(global, 'setInterval');
        const timeout = jest.spyOn(global, 'setTimeout');
        try {
          const entry = require('../packages/api/src/upload-activation');
          expect(entry.inspectCheckpointIndexPopulation).toBe(
            require('../packages/api/src/agents/checkpoints/storage')
              .inspectCheckpointIndexPopulation,
          );
          expect(connect).not.toHaveBeenCalled();
          expect(create).not.toHaveBeenCalled();
          expect(interval).not.toHaveBeenCalled();
          expect(timeout).not.toHaveBeenCalled();
        } finally {
          connect.mockRestore();
          create.mockRestore();
          interval.mockRestore();
          timeout.mockRestore();
        }
      });
    } finally {
      jest.dontMock('../packages/api/src/stream/implementations/RedisJobStore');
    }
  });
  test('accepts only the closed inspection envelope without gateway authority', () => {
    expect(validateEnvelope(inspectionRequest(), NOW)).toEqual(inspectionRequest());
    for (const extra of ['stores', 'currentConfig', 'mongoUri', 'complete']) {
      expect(() => validateEnvelope({ ...inspectionRequest(), [extra]: [] }, NOW)).toThrow();
    }
    for (const originalDeadline of [
      new Date(NOW - 1).toISOString(),
      new Date(NOW + 300001).toISOString(),
      NOW + 1,
    ]) {
      expect(() => validateEnvelope({ ...inspectionRequest(), originalDeadline }, NOW)).toThrow();
    }
    expect(() =>
      validateEnvelope({ ...inspectionRequest(), historicalLineageSha256: 'bad' }, NOW),
    ).toThrow();
  });

  test.each([true, false])(
    'prints a compact exact report with complete=%s and the matching exit code',
    async (complete) => {
      const { runtime, boundary } = livePorts();
      const report = indexInspection();
      report.complete = complete;
      if (!complete) {
        report.collections[0].duplicateGroups = 1;
        report.collections[0].duplicateExcessRows = 2;
        report.collections[0].indexStatus = 'conflicting';
      }
      runtime.inspectCheckpointIndexes.mockResolvedValue(report);
      const captured = capture();
      const exit = await main({
        input: Readable.from([canonical(inspectionRequest())]),
        output: captured.output,
        env: {},
        now: boundary.now,
        open: boundary.open,
      });
      expect(exit).toBe(complete ? 0 : 1);
      const result = JSON.parse(captured.text());
      expect(result).toMatchObject({
        status: 'inspected',
        complete,
        inspectionEvidenceSha256: report.evidenceSha256,
        counts: {
          collections: 2,
          rows: 6,
          duplicateGroups: complete ? 0 : 1,
          duplicateExcessRows: complete ? 0 : 2,
          conflictingIndexCollections: complete ? 0 : 1,
        },
      });
      const { evidenceSha256, ...unsigned } = result;
      expect(evidenceSha256).toBe(digest(unsigned));
      expect(captured.text()).not.toContain('private_');
      expect(runtime.repository.initialize).not.toHaveBeenCalled();
      expect(runtime.repository.activateReconciled).not.toHaveBeenCalled();
      expect(runtime.inspectReplay).not.toHaveBeenCalled();
      expect(runtime.inspectCheckpoints).not.toHaveBeenCalled();
      expect(runtime.close).toHaveBeenCalledTimes(1);
    },
  );

  test.each([
    [
      'foreign target',
      (r) => {
        r.targetBindingSha256 = '0'.repeat(64);
      },
    ],
    [
      'foreign config',
      (r) => {
        r.configurationSha256 = '0'.repeat(64);
      },
    ],
    [
      'foreign lineage',
      (r) => {
        r.historicalLineageSha256 = '0'.repeat(64);
      },
    ],
    [
      'foreign owner',
      (r) => {
        r.owner = 'private-owner';
      },
    ],
    [
      'foreign deadline',
      (r) => {
        r.originalDeadline = new Date(NOW + 1).toISOString();
      },
    ],
    [
      'earlier observation',
      (r) => {
        r.observedFrom = new Date(NOW - 1).toISOString();
      },
    ],
    [
      'future observation',
      (r) => {
        r.observedThrough = new Date(NOW + 1).toISOString();
      },
    ],
    [
      'noncanonical time',
      (r) => {
        r.observedFrom = NOW;
      },
    ],
    [
      'unsafe count',
      (r) => {
        r.collections[0].rowCount = Number.MAX_SAFE_INTEGER + 1;
      },
    ],
    [
      'summed overflow',
      (r) => {
        r.collections.forEach((row) => {
          row.rowCount = Number.MAX_SAFE_INTEGER;
        });
      },
    ],
    [
      'negative count',
      (r) => {
        r.collections[0].malformedKeyRows = -1;
      },
    ],
    [
      'inconsistent complete',
      (r) => {
        r.complete = false;
      },
    ],
    [
      'owner value leak',
      (r) => {
        r.secret = 'private-owner-data';
      },
    ],
  ])('rejects %s before emitting an inspection result', async (_name, change) => {
    const { runtime, boundary } = livePorts();
    const report = indexInspection();
    change(report);
    runtime.inspectCheckpointIndexes.mockResolvedValue(report);
    const captured = capture();
    expect(
      await main({
        input: Readable.from([canonical(inspectionRequest())]),
        output: captured.output,
        env: {},
        now: boundary.now,
        open: boundary.open,
      }),
    ).toBe(1);
    expect(JSON.parse(captured.text())).toMatchObject({ schema: 1, status: 'error' });
    expect(captured.text()).not.toMatch(/private|UNKNOWN_COMMIT/);
    expect(runtime.close).toHaveBeenCalledTimes(1);
  });

  test('summarizes the full bounded owner population below 16KiB without exposing its metadata', async () => {
    const { runtime, boundary } = livePorts();
    const report = indexInspection();
    report.collections = Array.from({ length: 64 }, (_, n) => ({
      ...report.collections[n % 2],
      collection: `private-${n}`,
      indexes: Array.from({ length: 64 }, () => ({
        name: 'private-index'.repeat(8),
        building: false,
      })),
    }));
    expect(Buffer.byteLength(canonical(report))).toBeGreaterThan(INPUT_LIMIT);
    runtime.inspectCheckpointIndexes.mockResolvedValue(report);
    const captured = capture();
    expect(
      await main({
        input: Readable.from([canonical(inspectionRequest())]),
        output: captured.output,
        env: {},
        now: boundary.now,
        open: boundary.open,
      }),
    ).toBe(0);
    expect(Buffer.byteLength(captured.text())).toBeLessThan(INPUT_LIMIT);
    expect(captured.text()).not.toContain('private');
    expect(JSON.parse(captured.text()).counts).toMatchObject({ collections: 64, rows: 192 });
  });

  test.each(['read', 'close', 'unknown-commit'])(
    'sanitizes %s failure without pending commit semantics',
    async (failure) => {
      const { runtime, boundary } = livePorts();
      const error = Object.assign(
        new Error('private-uri'),
        failure === 'unknown-commit' ? { code: 'UNKNOWN_COMMIT' } : {},
      );
      (failure === 'close' ? runtime.close : runtime.inspectCheckpointIndexes).mockRejectedValue(
        error,
      );
      const captured = capture();
      expect(
        await main({
          input: Readable.from([canonical(inspectionRequest())]),
          output: captured.output,
          env: {},
          now: boundary.now,
          open: boundary.open,
        }),
      ).toBe(1);
      expect(JSON.parse(captured.text())).toEqual({
        schema: 1,
        status: 'error',
        code: 'UNAVAILABLE',
      });
      expect(runtime.close).toHaveBeenCalledTimes(1);
    },
  );

  test('joins closure before inspection stdout', async () => {
    const { runtime, boundary } = livePorts();
    let release;
    let closing;
    const began = new Promise((resolve) => {
      closing = resolve;
    });
    runtime.close.mockImplementation(() => {
      closing();
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const captured = capture();
    const result = main({
      input: Readable.from([canonical(inspectionRequest())]),
      output: captured.output,
      env: {},
      now: boundary.now,
      open: boundary.open,
    });
    await began;
    expect(captured.text()).toBe('');
    release();
    expect(await result).toBe(0);
  });

  test('aborts a pending inspection and joins its runtime before returning failure', async () => {
    jest.useFakeTimers();
    const { runtime, boundary } = livePorts();
    let inspecting;
    const began = new Promise((resolve) => {
      inspecting = resolve;
    });
    boundary.open.mockImplementation(async (_target, { signal }) => {
      runtime.inspectCheckpointIndexes.mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('private abort')), {
              once: true,
            });
            inspecting();
          }),
      );
      return runtime;
    });
    const result = runActivation(inspectionRequest(), boundary);
    const checked = result.catch((error) => error);
    try {
      await began;
      await jest.advanceTimersByTimeAsync(28000);
      await expect(checked).resolves.toMatchObject({ code: 'UNAVAILABLE' });
      expect(runtime.close).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test('bounds a stalled inspection stdout write after runtime closure', async () => {
    jest.useFakeTimers();
    const { runtime, boundary } = livePorts();
    let beganWrite;
    let finishWrite;
    const writing = new Promise((resolve) => {
      beganWrite = resolve;
    });
    const output = new Writable({
      write(_chunk, _encoding, done) {
        finishWrite = done;
        beganWrite();
      },
    });
    const result = main({
      input: Readable.from([canonical(inspectionRequest())]),
      output,
      env: {},
      now: boundary.now,
      open: boundary.open,
    }).catch((error) => error);
    try {
      await writing;
      expect(runtime.close).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(2000);
      await expect(result).resolves.toMatchObject({ code: 'UNAVAILABLE' });
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      if (finishWrite) finishWrite();
      output.destroy();
      jest.useRealTimers();
    }
  });
});

describe('finite initial activation envelope', () => {
  test('missing independent gateway context rejects before opening a client', async () => {
    const { boundary } = livePorts();
    delete boundary.storageGateways;
    await expect(runActivation(request(), boundary)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(boundary.open).not.toHaveBeenCalled();
  });

  test.each(['historical', 'foreign', 'reordered'])(
    'rejects %s receipt endpoints before any client',
    async (kind) => {
      const value = activation();
      if (kind === 'reordered') value.inventory.storage.gateways.reverse();
      else
        value.inventory.storage.gateways[0].endpoint =
          kind === 'historical' ? 'https://retired.example:8333' : 'https://foreign.invalid:8333';
      const { boundary, runtime } = livePorts();
      await expect(runActivation(value, boundary)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect(boundary.open).not.toHaveBeenCalled();
      expect(runtime.repository.activateReconciled).not.toHaveBeenCalled();
    },
  );

  test('raw CLI gateway context is required independently of receipt endpoints', async () => {
    const { boundary } = livePorts();
    const captured = capture();
    const code = await main({
      input: Readable.from([Buffer.from(canonical(activation()))]),
      output: captured.output,
      env: {},
      now: boundary.now,
      open: boundary.open,
    });
    expect(code).toBe(1);
    expect(JSON.parse(captured.text()).code).toBe('INVALID_INPUT');
    expect(boundary.open).not.toHaveBeenCalled();
  });

  test('reads a real segmented UTF-8 stdin envelope without adding authority fields', async () => {
    const value = request();
    const bytes = Buffer.from(JSON.stringify(value));
    const input = Readable.from([bytes.subarray(0, 7), bytes.subarray(7)]);
    await expect(readEnvelope(input, { timeoutMs: 100 })).resolves.toEqual(value);
  });

  test('bounds bytes rather than characters and destroys an oversized input', async () => {
    const input = new PassThrough();
    const pending = readEnvelope(input, { timeoutMs: 100 });
    const rejected = pending.catch((error) => error);
    input.end(Buffer.alloc(INPUT_LIMIT + 1, 120));
    await expect(rejected).resolves.toMatchObject({ code: 'INVALID_INPUT' });
    expect(input.destroyed).toBe(true);
  });

  test.each([Buffer.from('{'), Buffer.from([0x7b, 0xff, 0x7d]), Buffer.from('null')])(
    'rejects malformed JSON, malformed UTF-8 or a non-object without reflecting input',
    async (bytes) => {
      await expect(readEnvelope(Readable.from([bytes]), { timeoutMs: 100 })).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
    },
  );

  test('a stalled stdin is bounded and the owned stream is closed', async () => {
    jest.useFakeTimers();
    const input = new PassThrough();
    try {
      const pending = readEnvelope(input, { timeoutMs: 25 });
      const rejected = pending.catch((error) => error);
      await jest.advanceTimersByTimeAsync(25);
      await expect(rejected).resolves.toMatchObject({ code: 'INPUT_TIMEOUT' });
      expect(input.destroyed).toBe(true);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      input.destroy();
      jest.useRealTimers();
    }
  });

  test('accepts only the exact finite prepare contract without mutating its target', () => {
    const value = request();
    const before = cloneJson(value);
    expect(Object.getPrototypeOf(value.target)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(value.target.coordination)).toBe(Object.prototype);
    expect(validateEnvelope(value, NOW, GATEWAY_CONTEXT)).toEqual(value);
    expect(value).toEqual(before);
  });

  test.each([
    [
      'unknown top-level authority',
      (value) => {
        value.enabled = true;
      },
    ],
    [
      'caller baseline',
      (value) => {
        value.baseline = ZERO;
      },
    ],
    [
      'caller private proof',
      (value) => {
        value.proof = { historyCopiesAccounted: true };
      },
    ],
    [
      'unknown target key',
      (value) => {
        value.target.mongoUri = 'mongodb://private.invalid';
      },
    ],
    [
      'inherited target prototype',
      (value) => {
        value.target = Object.assign(Object.create({}), value.target);
      },
    ],
    [
      'null target prototype',
      (value) => {
        value.target = Object.assign(Object.create(null), value.target);
      },
    ],
    [
      'wrong fixed bucket',
      (value) => {
        value.target.bucket = 'other';
      },
    ],
    [
      'missing immutable image digest',
      (value) => {
        delete value.target.imageDigest;
      },
    ],
    [
      'wrong source identity',
      (value) => {
        value.target.sourceRevision = 'latest';
      },
    ],
    [
      'coerced identifier array',
      (value) => {
        value.target.imageDigest = [value.target.imageDigest];
      },
    ],
    [
      'Redis namespace ambiguity',
      (value) => {
        value.target.coordination.database = 1;
      },
    ],
    [
      'Redis wildcard prefix',
      (value) => {
        value.target.coordination.keyPrefix = '*::';
      },
    ],
    [
      'expired preparation',
      (value) => {
        value.originalDeadline = new Date(NOW).toISOString();
      },
    ],
    [
      'extended preparation deadline',
      (value) => {
        value.originalDeadline = new Date(NOW + 300_001).toISOString();
      },
    ],
    [
      'noncanonical time',
      (value) => {
        value.originalDeadline = '2026-10-14T00:12:00Z';
      },
    ],
  ])('rejects %s before opening any connection', (_label, mutate) => {
    const value = request();
    expect(validateEnvelope(value, NOW, GATEWAY_CONTEXT)).toEqual(value);
    mutate(value);
    expect(() => validateEnvelope(value, NOW, GATEWAY_CONTEXT)).toThrow();
  });
});

describe('initial preparation composes existing owners', () => {
  function ports() {
    const value = snapshot();
    const runtime = {
      target: cloneJson(TARGET),
      repository: {
        initialize: jest.fn().mockResolvedValue(undefined),
        reconciliationSnapshot: jest.fn().mockResolvedValue(value),
        activateReconciled: jest.fn(),
      },
      inspectReplay: jest.fn(),
      inspectCheckpoints: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    };
    return {
      value,
      runtime,
      boundary: {
        storageGateways: GATEWAY_CONTEXT,
        now: () => NOW,
        open: jest.fn().mockResolvedValue(runtime),
      },
    };
  }

  test('wrong connected target closes the connection without changing accounting', async () => {
    const { runtime, boundary } = ports();
    runtime.target.mongoDatabase = 'different';
    await expect(runActivation(request(), boundary)).rejects.toMatchObject({
      code: 'TARGET_MISMATCH',
    });
    expect(runtime.repository.initialize).not.toHaveBeenCalled();
    expect(runtime.repository.reconciliationSnapshot).not.toHaveBeenCalled();
    expect(runtime.close).toHaveBeenCalledTimes(1);
  });

  test('database source population cannot be converted into an empty proof', async () => {
    const { runtime, value, boundary } = ports();
    value.initialInventory.sourceMessages = 1;
    await expect(runActivation(request(), boundary)).rejects.toMatchObject({ code: 'NONEMPTY' });
    expect(runtime.repository.activateReconciled).not.toHaveBeenCalled();
    expect(runtime.close).toHaveBeenCalledTimes(1);
  });

  test('uncertain snapshot fails closed and still joins the existing connection boundary', async () => {
    const { runtime, boundary } = ports();
    runtime.repository.reconciliationSnapshot.mockRejectedValue(
      new Error('synthetic database failure'),
    );
    await expect(runActivation(request(), boundary)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(runtime.repository.activateReconciled).not.toHaveBeenCalled();
    expect(runtime.close).toHaveBeenCalledTimes(1);
  });
});

describe('owner observations and immutable activation proof', () => {
  test('canonical encoding preserves array order and UTF-8 while sorting all object keys', () => {
    expect(canonical({ z: 'é', b: { y: 1, a: 2 }, a: [3, 2] })).toBe(
      '{"a":[3,2],"b":{"a":2,"y":1},"z":"é"}',
    );
    expect(digest({ b: 2, a: 1 })).toBe(digest({ a: 1, b: 2 }));
  });

  test('prepare returns separate actual owner measurements and never activates', async () => {
    const { runtime, boundary } = livePorts();
    const result = await runActivation(request(), boundary);
    expect(result).toEqual({
      schema: 1,
      status: 'prepared',
      target: TARGET,
      originalDeadline: DEADLINE,
      preparation: activation().preparation,
    });
    expect(runtime.repository.initialize).toHaveBeenCalledTimes(1);
    expect(runtime.repository.reconciliationSnapshot).toHaveBeenCalledTimes(1);
    expect(runtime.repository.activateReconciled).not.toHaveBeenCalled();
    expect(runtime.inspectReplay).toHaveBeenCalledWith({
      originalDeadline: DEADLINE,
      targetBindingSha256: digest(TARGET),
    });
    expect(runtime.close).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['inspectReplay', 'generation-stream', 'originalDeadline'],
    ['inspectReplay', 'generation-stream', 'observedFrom'],
    ['inspectReplay', 'generation-stream', 'observedThrough'],
    ['inspectCheckpoints', 'agent-checkpoints', 'originalDeadline'],
    ['inspectCheckpoints', 'agent-checkpoints', 'observedFrom'],
    ['inspectCheckpoints', 'agent-checkpoints', 'observedThrough'],
  ])('refuses numeric %s owner %s field %s at the live boundary', async (port, owner, field) => {
    const { runtime, boundary } = livePorts();
    const observation = producer(owner);
    observation[field] = Date.parse(observation[field]);
    runtime[port].mockResolvedValue(observation);
    await expect(runActivation(request(), boundary)).rejects.toThrow();
    expect(runtime.repository.activateReconciled).not.toHaveBeenCalled();
    expect(runtime.close).toHaveBeenCalledTimes(1);
  });

  test.each([
    [
      'source jobs',
      (value) => {
        value.preparation.replayInventory.saturatedCounts.sourceJobs = 1;
      },
    ],
    [
      'retained intents',
      (value) => {
        value.preparation.replayInventory.saturatedCounts.replayIntents = 1;
      },
    ],
    [
      'checkpoint copies',
      (value) => {
        value.preparation.checkpointInventory.saturatedCounts.recoveryCopies = 1;
      },
    ],
    [
      'unknown checkpoint coverage',
      (value) => {
        value.preparation.checkpointInventory.complete = false;
      },
    ],
    [
      'local-only replay',
      (value) => {
        value.preparation.replayInventory.adapter = 'memory';
      },
    ],
    [
      'missing operation population',
      (value) => {
        delete value.preparation.initialInventory.operations;
      },
    ],
    [
      'nonzero unchanged baseline',
      (value) => {
        value.preparation.baseline.textBytes = 1;
      },
    ],
    [
      'nonzero live ledger',
      (value) => {
        value.preparation.ledgerTotals.recordBytes = 1;
      },
    ],
    [
      'object contents',
      (value) => {
        value.inventory.storage.saturatedCounts.objects = 1;
      },
    ],
    [
      'multipart reservation',
      (value) => {
        value.inventory.storage.saturatedCounts.multipartUploads = 1;
      },
    ],
    [
      'object retained bytes',
      (value) => {
        value.inventory.storage.measuredBytes.versionBytes = 1;
      },
    ],
    [
      'unfinished storage coverage',
      (value) => {
        value.inventory.storage.complete = false;
      },
    ],
    [
      'gateway disagreement',
      (value) => {
        value.inventory.storage.gateways[1].versioning['cortex-managed-uploads'] = 'Enabled';
      },
    ],
    [
      'missing admitted bucket',
      (value) => {
        value.inventory.storage.buckets.pop();
      },
    ],
    [
      'storage target mismatch',
      (value) => {
        value.inventory.storage.targetBindingSha256 = '0'.repeat(64);
      },
    ],
    [
      'storage observed before preparation',
      (value) => {
        value.inventory.storage.observedFrom = new Date(NOW - 1).toISOString();
      },
    ],
    [
      'future observation',
      (value) => {
        value.inventory.storage.observedThrough = new Date(NOW + 1).toISOString();
      },
    ],
    [
      'replacement original deadline',
      (value) => {
        value.inventory.staging.originalDeadline = new Date(NOW + 240_000).toISOString();
      },
    ],
    [
      'staged copy',
      (value) => {
        value.inventory.staging.saturatedCounts.stagedCopies = 1;
      },
    ],
    [
      'unknown writer',
      (value) => {
        value.inventory.staging.saturatedCounts.unresolvedWriters = 1;
      },
    ],
    [
      'held local bytes',
      (value) => {
        value.inventory.staging.measuredBytes.heldBytes = 1;
      },
    ],
    [
      'duplicate host',
      (value) => {
        value.inventory.staging.eligibleHosts.push('node-a');
      },
    ],
    [
      'missing pod evidence',
      (value) => {
        value.inventory.staging.podUids = [];
      },
    ],
    [
      'unknown producer assertion',
      (value) => {
        value.inventory.staging.empty = true;
      },
    ],
    [
      'coerced hash array',
      (value) => {
        value.inventory.storage.evidenceSha256 = [value.inventory.storage.evidenceSha256];
      },
    ],
  ])('refuses %s without opening clients or requesting activation', async (_label, mutate) => {
    const value = activation();
    expect(validateEnvelope(value, NOW, GATEWAY_CONTEXT)).toEqual(value);
    mutate(value);
    const { boundary } = livePorts();
    await expect(runActivation(value, boundary)).rejects.toThrow();
    expect(boundary.open).not.toHaveBeenCalled();
  });

  test('fresh activation repeats current replay/checkpoint observations without replacing the retained proof', async () => {
    const value = activation();
    const retained = canonical(value);
    const { runtime, boundary } = livePorts();
    const result = await runActivation(value, boundary);
    expect(runtime.repository.initialize).not.toHaveBeenCalled();
    expect(runtime.repository.reconciliationSnapshot).not.toHaveBeenCalled();
    expect(runtime.inspectReplay).toHaveBeenCalledTimes(1);
    expect(runtime.inspectCheckpoints).toHaveBeenCalledTimes(1);
    const proof = runtime.repository.activateReconciled.mock.calls[0][0];
    expect(proof).toEqual({
      storeId: value.preparation.storeId,
      revision: value.preparation.revision,
      baseline: ZERO,
      observedAt: value.preparation.observedAt,
      originalDeadline: DEADLINE,
      inventoryEvidenceId: 'sha256:' + digest(value),
      historyCopiesAccounted: true,
      admission: 'initial-empty',
    });
    expect(result).toMatchObject({
      status: 'active',
      evidenceSha256: digest(value),
      proofSha256: digest(proof),
    });
    expect(canonical(value)).toBe(retained);
    expect(runtime.close).toHaveBeenCalledTimes(1);
  });

  test('a new replay copy after preparation blocks commit and preserves the exact preparation', async () => {
    const value = activation();
    const retained = canonical(value);
    const { runtime, boundary } = livePorts();
    const changed = producer('generation-stream');
    changed.saturatedCounts.recoveryCopies = 1;
    runtime.inspectReplay.mockResolvedValue(changed);
    await expect(runActivation(value, boundary)).rejects.toMatchObject({ code: 'NONEMPTY' });
    expect(runtime.repository.activateReconciled).not.toHaveBeenCalled();
    expect(canonical(value)).toBe(retained);
    expect(runtime.close).toHaveBeenCalledTimes(1);
  });

  test('current checkpoint configuration must still match the retained owner measurement', async () => {
    const { runtime, boundary } = livePorts();
    runtime.configurationSha256 = '1'.repeat(64);
    await expect(runActivation(activation(), boundary)).rejects.toMatchObject({
      code: 'TARGET_MISMATCH',
    });
    expect(runtime.repository.activateReconciled).not.toHaveBeenCalled();
    expect(runtime.close).toHaveBeenCalledTimes(1);
  });

  test('unknown first commit replays identical proof after expiry without fresh scans or new snapshot', async () => {
    const value = activation();
    const retained = canonical(value);
    const { runtime, boundary } = livePorts();
    runtime.repository.activateReconciled.mockRejectedValueOnce(
      new Error('reply lost after commit'),
    );
    await expect(runActivation(value, boundary)).rejects.toMatchObject({ code: 'UNKNOWN_COMMIT' });
    const firstProof = cloneJson(runtime.repository.activateReconciled.mock.calls[0][0]);
    const expiredNow = Date.parse(DEADLINE) + 1;
    boundary.now = () => expiredNow;
    const result = await runActivation(value, boundary);
    expect(result.status).toBe('active');
    expect(runtime.repository.activateReconciled.mock.calls[1][0]).toEqual(firstProof);
    expect(runtime.repository.activateReconciled.mock.calls[1][1]).toBe(expiredNow);
    expect(runtime.inspectReplay).toHaveBeenCalledTimes(1);
    expect(runtime.inspectCheckpoints).toHaveBeenCalledTimes(1);
    expect(runtime.repository.reconciliationSnapshot).not.toHaveBeenCalled();
    expect(runtime.repository.initialize).not.toHaveBeenCalled();
    expect(boundary.open.mock.calls[1][1]).toMatchObject({
      expiredReplay: true,
      deadline: expiredNow + 15_000,
    });
    expect(canonical(value)).toBe(retained);
    expect(runtime.close).toHaveBeenCalledTimes(2);
  });

  test('expired or retired unknown proof cannot be converted into a new preparation', async () => {
    const { runtime, boundary } = livePorts();
    boundary.now = () => Date.parse(DEADLINE) + 1;
    runtime.repository.activateReconciled.mockRejectedValue(
      new Error('store refuses uncommitted/retired proof'),
    );
    await expect(runActivation(activation(), boundary)).rejects.toMatchObject({
      code: 'UNKNOWN_COMMIT',
    });
    expect(runtime.inspectReplay).not.toHaveBeenCalled();
    expect(runtime.inspectCheckpoints).not.toHaveBeenCalled();
    expect(runtime.repository.reconciliationSnapshot).not.toHaveBeenCalled();
    expect(runtime.repository.initialize).not.toHaveBeenCalled();
    expect(runtime.close).toHaveBeenCalledTimes(1);
  });

  test('crossing the original deadline during inspection cannot commit', async () => {
    const { runtime, boundary } = livePorts();
    let current = NOW;
    boundary.now = () => current;
    runtime.inspectReplay.mockImplementation(async () => {
      current = Date.parse(DEADLINE) + 1;
      return producer('generation-stream');
    });
    await expect(runActivation(activation(), boundary)).rejects.toMatchObject({ code: 'EXPIRED' });
    expect(runtime.repository.activateReconciled).not.toHaveBeenCalled();
    expect(runtime.close).toHaveBeenCalledTimes(1);
  });

  test('failed closure after activation cannot emit a successful settled receipt', async () => {
    const { runtime, boundary } = livePorts();
    runtime.close.mockRejectedValue(new Error('close failed'));
    await expect(runActivation(activation(), boundary)).rejects.toMatchObject({
      code: 'UNKNOWN_COMMIT',
    });
  });

  test.each([
    ['prepared result', request, () => undefined, 'UNAVAILABLE', 'error'],
    [
      'pre-activation target failure',
      activation,
      (runtime) => {
        runtime.target.mongoDatabase = 'different';
      },
      'UNAVAILABLE',
      'error',
    ],
    [
      'attempted activation failure',
      activation,
      (runtime) => {
        runtime.repository.activateReconciled.mockRejectedValue(new Error('commit reply lost'));
      },
      'UNKNOWN_COMMIT',
      'pending',
    ],
  ])(
    'failed closure overrides %s without publishing a success receipt',
    async (_label, envelope, changeRuntime, code, status) => {
      const { runtime, boundary } = livePorts();
      const captured = capture();
      changeRuntime(runtime);
      runtime.close.mockRejectedValue(new Error('private closure failure'));
      const result = await main({
        input: Readable.from([Buffer.from(canonical(envelope()))]),
        output: captured.output,
        env: GATEWAY_ENV,
        now: boundary.now,
        open: boundary.open,
      });
      expect(result).toBe(1);
      expect(captured.text()).toBe(canonical({ schema: 1, status, code }) + '\n');
      expect(runtime.close).toHaveBeenCalledTimes(1);
    },
  );

  test.each([
    ['prepare', request, 'prepared'],
    ['activate', activation, 'active'],
  ])('withholds %s stdout until client closure settles', async (_action, envelope, status) => {
    const { runtime, boundary } = livePorts();
    const captured = capture();
    let finishClose;
    let beganClose;
    const closed = new Promise((resolve) => {
      finishClose = resolve;
    });
    const closing = new Promise((resolve) => {
      beganClose = resolve;
    });
    runtime.close.mockImplementation(() => {
      beganClose();
      return closed;
    });
    const pending = main({
      input: Readable.from([Buffer.from(canonical(envelope()))]),
      output: captured.output,
      env: GATEWAY_ENV,
      now: boundary.now,
      open: boundary.open,
    });
    let result;
    try {
      await closing;
      await new Promise((resolve) => setImmediate(resolve));
      expect(captured.text()).toBe('');
      expect(runtime.close).toHaveBeenCalledTimes(1);
    } finally {
      finishClose();
      result = await pending;
    }
    expect(result).toBe(0);
    expect(JSON.parse(captured.text())).toMatchObject({ schema: 1, status });
    expect(captured.text().trim().split('\n')).toHaveLength(1);
  });

  test('stdout is one bounded aggregate JSON with no raw failure, credential, URI or input reflection', async () => {
    const value = activation();
    const { runtime, boundary } = livePorts();
    const captured = capture();
    runtime.repository.activateReconciled.mockRejectedValue(
      new Error('mongodb://secret:test-password@private.invalid/content'),
    );
    const result = await main({
      input: Readable.from([Buffer.from(canonical(value))]),
      output: captured.output,
      env: GATEWAY_ENV,
      now: boundary.now,
      open: boundary.open,
    });
    expect(result).toBe(1);
    expect(captured.text()).toBe('{"code":"UNKNOWN_COMMIT","schema":1,"status":"pending"}\n');
    expect(Buffer.byteLength(captured.text())).toBeLessThan(INPUT_LIMIT);
  });

  test('missing independent process target is refused before any runtime module or connection', async () => {
    const captured = capture();
    const result = await main({
      input: Readable.from([Buffer.from(canonical(request()))]),
      output: captured.output,
      env: GATEWAY_ENV,
      now: () => NOW,
    });
    expect(result).toBe(1);
    expect(JSON.parse(captured.text())).toEqual({
      schema: 1,
      status: 'error',
      code: 'TARGET_MISMATCH',
    });
  });
});

describe('one-shot adapter uses public owners and independently checked runtime identity', () => {
  let runtime;
  let env;
  let mongoose;
  let redisClients;
  let models;
  let shared;
  let initializeStore;
  beforeEach(() => {
    jest.resetModules();
    runtime = livePorts().runtime;
    redisClients = [];
    models = jest.fn();
    initializeStore = jest.fn();
    shared = {
      mode: 'sentinel',
      name: TARGET.coordination.sentinelName,
      endpoints: [{ host: 'sentinel.example.invalid', port: 26379 }],
      username: 'fixture-user',
      password: 'synthetic-redacted',
      caPath: '/synthetic/ca',
      sentinelUsername: 'fixture-sentinel',
      sentinelPassword: 'synthetic-redacted',
      sentinelCaPath: '/synthetic/sentinel-ca',
    };
    env = {
      ...GATEWAY_ENV,
      CORTEX_UPLOAD_ACTIVATION_TARGET: canonical(TARGET),
      CORTEX_UPLOAD_ACTIVATION_CHECKPOINTER: '{}',
      REDIS_KEY_PREFIX: 'cortex',
      MONGO_URI:
        'mongodb://synthetic:test-never-used@mongo.example.invalid/LibreChat?replicaSet=cortex-rs',
    };
    mongoose = {
      set: jest.fn(),
      connect: jest.fn().mockResolvedValue(undefined),
      connection: {
        name: TARGET.mongoDatabase,
        on: jest.fn(),
        off: jest.fn(),
        close: jest.fn().mockResolvedValue(undefined),
        db: {
          admin: () => ({
            command: jest.fn().mockResolvedValue({ setName: TARGET.mongoReplicaSet }),
          }),
        },
      },
    };
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    const reads = new Set();
    let fd = 100;
    const fs = require('node:fs');
    jest.spyOn(fs, 'openSync').mockImplementation(() => ++fd);
    jest.spyOn(fs, 'fstatSync').mockReturnValue({ isFile: () => true, size: 12 });
    jest.spyOn(fs, 'readSync').mockImplementation((handle, bytes, offset) => {
      if (reads.has(handle)) return 0;
      reads.add(handle);
      return bytes.write('synthetic-ca', offset);
    });
    jest.spyOn(fs, 'closeSync').mockImplementation(() => {});
    jest.doMock('mongoose', () => mongoose);
    jest.doMock('librechat-data-provider', () => ({ parseSharedState: jest.fn(() => shared) }));
    jest.doMock('@librechat/data-schemas', () => ({
      createModels: models,
      createUploadManagementRepository: jest.fn(() => runtime.repository),
    }));
    jest.doMock(
      '@librechat/api/upload-activation',
      () => ({
        parseUploadActivationGatewayContext,
        validateUploadActivationGateways,
        resolveCheckpointerConfig: jest.fn(() => CONFIG),
        RedisJobStore: class {
          initialize = initializeStore;
          inspectInitialSourcePopulation = (...args) => runtime.inspectReplay(...args);
        },
        inspectInitialCheckpointPopulation: (...args) => runtime.inspectCheckpoints(...args),
        inspectCheckpointIndexPopulation: (...args) => runtime.inspectCheckpointIndexes(...args),
      }),
      { virtual: true },
    );
    jest.doMock('ioredis', () => {
      const { EventEmitter } = require('node:events');
      return class extends EventEmitter {
        constructor(options) {
          super();
          this.options = options;
          this.status = 'wait';
          redisClients.push(this);
          this.connect = jest.fn(async () => {
            this.status = 'ready';
          });
          this.disconnect = jest.fn(() => {
            this.status = 'end';
            this.emit('end');
          });
        }
      };
    });
  });
  afterEach(() => {
    jest.restoreAllMocks();
    for (const id of [
      'mongoose',
      'librechat-data-provider',
      '@librechat/data-schemas',
      '@librechat/api/upload-activation',
      'ioredis',
    ])
      jest.dontMock(id);
  });
  async function invoke(value = request()) {
    const captured = capture();
    const code = await main({
      input: Readable.from([Buffer.from(canonical(value))]),
      output: captured.output,
      env,
      now: () => NOW,
    });
    return { code, result: JSON.parse(captured.text()) };
  }

  function inspectionEnvironment() {
    delete env.CORTEX_UPLOAD_ACTIVATION_STORAGE_GATEWAYS;
    delete env.REDIS_KEY_PREFIX;
    env.CORTEX_UPLOAD_ACTIVATION_CHECKPOINT_LINEAGE = canonical(lineage());
    models.mockImplementation(() => {
      throw new Error('models must remain unopened');
    });
    require('librechat-data-provider').parseSharedState.mockImplementation(() => {
      throw new Error('Redis must remain unopened');
    });
    require('@librechat/data-schemas').createUploadManagementRepository.mockImplementation(() => {
      throw new Error('repository must remain unopened');
    });
  }

  test('actual inspection branch needs only Mongo and trusted lineage, never activation owners', async () => {
    inspectionEnvironment();
    const { code, result } = await invoke(inspectionRequest());
    expect(code).toBe(0);
    expect(result.status).toBe('inspected');
    expect(runtime.inspectCheckpointIndexes).toHaveBeenCalledWith({
      originalDeadline: DEADLINE,
      targetBindingSha256: digest(TARGET),
      currentConfig: CONFIG,
      historicalStorageLineage: { evidenceSha256: lineage().evidenceSha256, stores: [] },
    });
    expect(models).not.toHaveBeenCalled();
    expect(redisClients).toHaveLength(0);
    expect(initializeStore).not.toHaveBeenCalled();
    expect(require('node:fs').openSync).not.toHaveBeenCalled();
    expect(mongoose.connection.close).toHaveBeenCalledWith(true);
  });

  test.each([
    'missing',
    'foreign target',
    'foreign config',
    'foreign evidence',
    'oversized',
    'unknown field',
  ])('rejects %s trusted lineage before connecting', async (kind) => {
    inspectionEnvironment();
    const context = lineage();
    if (kind === 'foreign target') context.targetBindingSha256 = '0'.repeat(64);
    if (kind === 'foreign config') context.configurationSha256 = '0'.repeat(64);
    if (kind === 'foreign evidence') context.evidenceSha256 = '0'.repeat(64);
    if (kind === 'oversized') context.stores = Array.from({ length: 33 }, () => ({}));
    if (kind === 'unknown field') context.permission = true;
    env.CORTEX_UPLOAD_ACTIVATION_CHECKPOINT_LINEAGE = canonical(context);
    if (kind === 'missing') delete env.CORTEX_UPLOAD_ACTIVATION_CHECKPOINT_LINEAGE;
    const { code, result } = await invoke(inspectionRequest());
    expect(code).toBe(1);
    expect(result.status).toBe('error');
    let expected = 'INCOMPLETE';
    if (kind.startsWith('foreign')) expected = 'TARGET_MISMATCH';
    if (kind === 'unknown field') expected = 'INVALID_INPUT';
    expect(result.code).toBe(expected);
    expect(mongoose.connect).not.toHaveBeenCalled();
  });

  test.each(['replica', 'database'])(
    'rejects an actual Mongo %s mismatch and closes without inspection',
    async (kind) => {
      inspectionEnvironment();
      if (kind === 'database') mongoose.connection.name = 'foreign';
      else mongoose.connection.db.admin = () => ({ command: async () => ({ setName: 'foreign' }) });
      const { result } = await invoke(inspectionRequest());
      expect(result.code).toBe('TARGET_MISMATCH');
      expect(runtime.inspectCheckpointIndexes).not.toHaveBeenCalled();
      expect(mongoose.connection.close).toHaveBeenCalledWith(true);
    },
  );

  test('snapshots trusted lineage before the first connection await', async () => {
    inspectionEnvironment();
    mongoose.connect.mockImplementation(async () => {
      env.CORTEX_UPLOAD_ACTIVATION_CHECKPOINT_LINEAGE = canonical({
        ...lineage(),
        stores: [{ private: 'changed' }],
      });
    });
    expect((await invoke(inspectionRequest())).code).toBe(0);
    expect(
      runtime.inspectCheckpointIndexes.mock.calls[0][0].historicalStorageLineage.stores,
    ).toEqual([]);
  });

  test('real adapter composition opens only its finite Mongo/Sentinel clients and joins both', async () => {
    const { code, result } = await invoke();
    expect(code).toBe(0);
    expect(result.status).toBe('prepared');
    expect(mongoose.connect).toHaveBeenCalledWith(
      env.MONGO_URI,
      expect.objectContaining({
        maxPoolSize: 2,
        minPoolSize: 0,
        serverSelectionTimeoutMS: 2000,
        connectTimeoutMS: 2000,
        socketTimeoutMS: 2000,
        autoIndex: false,
        autoCreate: false,
        bufferCommands: false,
      }),
    );
    expect(models).toHaveBeenCalledWith(mongoose);
    expect(redisClients).toHaveLength(1);
    const client = redisClients[0];
    expect(client.options).toMatchObject({
      db: 0,
      keyPrefix: TARGET.coordination.keyPrefix,
      enableTLSForSentinelMode: true,
      tls: { ca: 'synthetic-ca', rejectUnauthorized: true },
      sentinelTLS: { ca: 'synthetic-ca', rejectUnauthorized: true },
      lazyConnect: true,
      enableOfflineQueue: false,
      autoResendUnfulfilledCommands: false,
      connectTimeout: 2000,
      commandTimeout: 2000,
      maxRetriesPerRequest: 0,
    });
    expect(client.options.retryStrategy(1)).toBeNull();
    expect(client.options.sentinelRetryStrategy(1)).toBeNull();
    expect(initializeStore).not.toHaveBeenCalled();
    expect(runtime.inspectReplay).toHaveBeenCalledWith({
      originalDeadline: DEADLINE,
      targetBindingSha256: digest(TARGET),
    });
    expect(runtime.inspectCheckpoints).toHaveBeenCalledWith({
      originalDeadline: DEADLINE,
      targetBindingSha256: digest(TARGET),
      currentConfig: CONFIG,
    });
    expect(client.disconnect).toHaveBeenCalledWith(false);
    expect(mongoose.connection.close).toHaveBeenCalledWith(true);
  });

  test('a mismatched actual Mongo replica set closes before models or Redis can initialize', async () => {
    mongoose.connection.db.admin = () => ({
      command: jest.fn().mockResolvedValue({ setName: 'wrong-rs' }),
    });
    const { code, result } = await invoke();
    expect(code).toBe(1);
    expect(result.code).toBe('TARGET_MISMATCH');
    expect(models).not.toHaveBeenCalled();
    expect(redisClients).toHaveLength(0);
    expect(mongoose.connection.close).toHaveBeenCalledWith(true);
  });

  test('the bound Sentinel identity must match before Mongo or any native connection is opened', async () => {
    shared.name = 'different';
    const { result } = await invoke();
    expect(result.code).toBe('TARGET_MISMATCH');
    expect(mongoose.connect).not.toHaveBeenCalled();
    expect(redisClients).toHaveLength(0);
  });

  test('missing independent checkpoint config cannot silently select defaults', async () => {
    delete env.CORTEX_UPLOAD_ACTIVATION_CHECKPOINTER;
    const { result } = await invoke();
    expect(result.code).toBe('TARGET_MISMATCH');
    expect(mongoose.connect).not.toHaveBeenCalled();
  });

  test('expired exact retry opens no Redis, takes no census and closes its Mongo connection', async () => {
    const expiredNow = Date.parse(DEADLINE) + 1;
    Date.now.mockReturnValue(expiredNow);
    const captured = capture();
    const code = await main({
      input: Readable.from([Buffer.from(canonical(activation()))]),
      output: captured.output,
      env,
      now: () => expiredNow,
    });
    expect(code).toBe(0);
    expect(redisClients).toHaveLength(0);
    expect(runtime.repository.initialize).not.toHaveBeenCalled();
    expect(runtime.repository.reconciliationSnapshot).not.toHaveBeenCalled();
    expect(runtime.inspectReplay).not.toHaveBeenCalled();
    expect(runtime.inspectCheckpoints).not.toHaveBeenCalled();
    expect(runtime.repository.activateReconciled).toHaveBeenCalledWith(
      expect.objectContaining({
        originalDeadline: DEADLINE,
        admission: 'initial-empty',
      }),
      expiredNow,
    );
    expect(mongoose.connection.close).toHaveBeenCalledWith(true);
  });
});
