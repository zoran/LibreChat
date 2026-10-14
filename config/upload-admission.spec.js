/** Finite admission operator tests; all database and transport boundaries are inert fixtures. */
'use strict';

const { EventEmitter } = require('node:events');
const { PassThrough, Readable, Writable } = require('node:stream');
const {
  readEnvelope,
  validateEnvelope,
  runAdmission,
  openRuntime,
  main,
} = require('./upload-admission');

const NOW = Date.parse('2026-10-14T04:00:00.000Z');
const STORE = 'b3452f80-3c50-457c-a9e1-a4b71f4bc953';
const target = { mongoReplicaSet: 'fixture-rs', mongoDatabase: 'FixtureChat' };
const command = () => ({
  storeId: STORE,
  expectedRevision: 4,
  paused: true,
  originalDeadline: new Date(NOW + 120_000).toISOString(),
});
const request = (action = 'set') => ({
  schema: 1,
  action,
  target: { ...target },
  ...(action === 'set' ? { command: command() } : {}),
});
const policy = () => ({ storeId: STORE, revision: 5, paused: true });
function fixture() {
  const runtime = {
    target: { ...target },
    repository: {
      getAdmissionPolicy: jest.fn(async () => policy()),
      setAdmissionPolicy: jest.fn(async () => policy()),
      initialize: jest.fn(),
      activateReconciled: jest.fn(),
    },
    close: jest.fn(async () => undefined),
  };
  return { runtime, ports: { now: () => NOW, open: jest.fn(async () => runtime) } };
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

describe('finite upload admission command', () => {
  test('reads bounded segmented UTF-8 and rejects oversized, malformed or stalled input', async () => {
    const bytes = Buffer.from(JSON.stringify(request()));
    await expect(
      readEnvelope(Readable.from([bytes.subarray(0, 11), bytes.subarray(11)])),
    ).resolves.toEqual(request());
    for (const invalid of [
      Buffer.alloc(16 * 1024 + 1, 120),
      Buffer.from([0xff]),
      Buffer.from('null'),
    ]) {
      await expect(readEnvelope(Readable.from([invalid]))).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
    }
    jest.useFakeTimers();
    const input = new PassThrough();
    try {
      const pending = readEnvelope(input);
      await Promise.all([
        expect(pending).rejects.toMatchObject({ code: 'INPUT_TIMEOUT' }),
        jest.advanceTimersByTimeAsync(5000),
      ]);
      expect(input.destroyed).toBe(true);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      input.destroy();
      jest.useRealTimers();
    }
  });

  test.each([
    (value) => {
      value.enabled = true;
    },
    (value) => {
      value.target.uri = 'mongodb://private.invalid';
    },
    (value) => {
      value.command.paused = 'true';
    },
    (value) => {
      value.command.expectedRevision = -1;
    },
    (value) => {
      value.command.now = NOW;
    },
    (value) => {
      value.command.originalDeadline = NOW + 120_000;
    },
    (value) => {
      value.command.originalDeadline = '2026-10-14T04:02:00Z';
    },
    (value) => {
      value.command.originalDeadline = new Date(NOW + 300_001).toISOString();
    },
    (value) => {
      value.target = Object.assign(Object.create({ hidden: true }), target);
    },
  ])('refuses noncanonical or extra authority before opening a client', async (change) => {
    const value = request();
    change(value);
    const f = fixture();
    await expect(runAdmission(value, f.ports)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(f.ports.open).not.toHaveBeenCalled();
  });

  test('copies validated primitives before awaiting and performs only the requested policy operation', async () => {
    const value = request();
    const f = fixture();
    f.ports.open.mockImplementationOnce(async () => {
      value.command.paused = false;
      value.command.originalDeadline = new Date(NOW + 300_000).toISOString();
      value.target.mongoDatabase = 'AnotherDatabase';
      return f.runtime;
    });
    await expect(runAdmission(value, f.ports)).resolves.toEqual({
      schema: 1,
      action: 'set',
      policy: policy(),
      observedAt: new Date(NOW).toISOString(),
    });
    expect(f.runtime.repository.setAdmissionPolicy).toHaveBeenCalledWith(command());
    expect(f.runtime.repository.getAdmissionPolicy).not.toHaveBeenCalled();
    expect(f.runtime.repository.initialize).not.toHaveBeenCalled();
    expect(f.runtime.repository.activateReconciled).not.toHaveBeenCalled();
    expect(f.runtime.close).toHaveBeenCalledTimes(1);
  });

  test('status reads existing policy without any setter or initialization and owns a 30s window', async () => {
    const f = fixture();
    await expect(runAdmission(request('status'), f.ports)).resolves.toMatchObject({
      action: 'status',
      policy: policy(),
    });
    expect(f.runtime.repository.getAdmissionPolicy).toHaveBeenCalledTimes(1);
    expect(f.runtime.repository.setAdmissionPolicy).not.toHaveBeenCalled();
    expect(f.runtime.repository.initialize).not.toHaveBeenCalled();
    expect(f.ports.open).toHaveBeenCalledWith(
      target,
      expect.objectContaining({ deadline: NOW + 30_000, expiredReplay: false }),
    );
  });

  test('retains the original expired command and uses a separate 15s transport window', async () => {
    const value = request();
    value.command.originalDeadline = new Date(NOW - 1).toISOString();
    const f = fixture();
    await runAdmission(value, f.ports);
    expect(f.runtime.repository.setAdmissionPolicy).toHaveBeenCalledWith(value.command);
    expect(f.ports.open).toHaveBeenCalledWith(
      target,
      expect.objectContaining({ deadline: NOW + 15_000, expiredReplay: true }),
    );
    expect(validateEnvelope(value, NOW).command.originalDeadline).toBe(
      value.command.originalDeadline,
    );
  });

  test.each(['invalid_request', 'not_ready', 'unavailable', 'migration_conflict'])(
    'preserves definitive repository domain rejection %s without claiming an unknown commit',
    async (code) => {
      const f = fixture();
      f.runtime.repository.setAdmissionPolicy.mockRejectedValueOnce(
        Object.assign(new Error('private detail'), { name: 'UploadManagementError', code }),
      );
      await expect(runAdmission(request(), f.ports)).rejects.toMatchObject({ code });
      expect(f.runtime.close).toHaveBeenCalledTimes(1);
    },
  );

  test('lost setter results and failed closure after dispatch stay unknown, while reads remain read failures', async () => {
    for (const failure of ['setter', 'close']) {
      const f = fixture();
      if (failure === 'setter')
        f.runtime.repository.setAdmissionPolicy.mockRejectedValueOnce(
          new Error('mongodb://private'),
        );
      else f.runtime.close.mockRejectedValueOnce(new Error('private close'));
      await expect(runAdmission(request(), f.ports)).rejects.toMatchObject({
        code: 'UNKNOWN_COMMIT',
      });
    }
    const read = fixture();
    read.runtime.repository.getAdmissionPolicy.mockRejectedValueOnce(new Error('private read'));
    await expect(runAdmission(request('status'), read.ports)).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
    expect(read.runtime.repository.setAdmissionPolicy).not.toHaveBeenCalled();
  });

  test('wrong connected target refuses mutation, and an invalid acknowledged policy cannot become success', async () => {
    const wrong = fixture();
    wrong.runtime.target.mongoDatabase = 'OtherDatabase';
    await expect(runAdmission(request(), wrong.ports)).rejects.toMatchObject({
      code: 'TARGET_MISMATCH',
    });
    expect(wrong.runtime.repository.setAdmissionPolicy).not.toHaveBeenCalled();
    expect(wrong.runtime.close).toHaveBeenCalledTimes(1);
    const invalid = fixture();
    invalid.runtime.repository.setAdmissionPolicy.mockResolvedValueOnce({
      ...policy(),
      paused: false,
    });
    await expect(runAdmission(request(), invalid.ports)).rejects.toMatchObject({
      code: 'UNKNOWN_COMMIT',
    });
  });

  test('reserves two seconds for bounded closure and cannot wait indefinitely for a setter', async () => {
    jest.useFakeTimers().setSystemTime(NOW);
    const f = fixture();
    f.ports.now = Date.now;
    f.runtime.repository.setAdmissionPolicy.mockImplementationOnce(() => new Promise(() => {}));
    try {
      const pending = runAdmission(request(), f.ports);
      await Promise.all([
        expect(pending).rejects.toMatchObject({ code: 'UNKNOWN_COMMIT' }),
        jest.advanceTimersByTimeAsync(28_000),
      ]);
      expect(f.runtime.close).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test('a never-settling close remains finite and cannot turn an acknowledged write into success', async () => {
    jest.useFakeTimers().setSystemTime(NOW);
    const f = fixture();
    f.ports.now = Date.now;
    f.runtime.close.mockImplementationOnce(() => new Promise(() => {}));
    try {
      const pending = runAdmission(request(), f.ports);
      await Promise.all([
        expect(pending).rejects.toMatchObject({ code: 'UNKNOWN_COMMIT' }),
        jest.advanceTimersByTimeAsync(2000),
      ]);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test('main emits only bounded sanitized JSON and never reflects private errors', async () => {
    const f = fixture();
    f.runtime.repository.setAdmissionPolicy.mockRejectedValueOnce(
      new Error('mongodb://credential@private'),
    );
    const output = capture();
    expect(
      await main({
        input: Readable.from([JSON.stringify(request())]),
        output: output.output,
        open: f.ports.open,
        now: f.ports.now,
      }),
    ).toBe(1);
    expect(JSON.parse(output.text())).toEqual({
      schema: 1,
      status: 'pending',
      code: 'UNKNOWN_COMMIT',
    });
    expect(output.text()).not.toContain('credential');
    expect(Buffer.byteLength(output.text())).toBeLessThanOrEqual(16 * 1024);
  });

  test('main retains a definitive domain code rather than relabeling a refusal as unavailable', async () => {
    const f = fixture();
    f.runtime.repository.setAdmissionPolicy.mockRejectedValueOnce(
      Object.assign(new Error('private refusal'), {
        name: 'UploadManagementError',
        code: 'not_ready',
      }),
    );
    const output = capture();
    expect(
      await main({
        input: Readable.from([JSON.stringify(request())]),
        output: output.output,
        open: f.ports.open,
        now: f.ports.now,
      }),
    ).toBe(1);
    expect(JSON.parse(output.text())).toEqual({ schema: 1, status: 'error', code: 'not_ready' });
  });
});

describe('DB-only admission runtime', () => {
  let client;
  let models;
  let repository;
  let controller;
  let options;
  let env;
  beforeEach(() => {
    controller = new AbortController();
    options = { deadline: Date.now() + 30_000, expiredReplay: false, signal: controller.signal };
    env = {
      MONGO_URI: 'mongodb://fixture.invalid/FixtureChat',
      CORTEX_UPLOAD_ADMISSION_TARGET: JSON.stringify(target),
    };
    const connection = Object.assign(new EventEmitter(), {
      name: target.mongoDatabase,
      db: {
        admin: () => ({ command: jest.fn(async () => ({ setName: target.mongoReplicaSet })) }),
      },
      close: jest.fn(async () => undefined),
    });
    client = { connection, set: jest.fn(), connect: jest.fn(async () => undefined) };
    models = jest.fn();
    repository = jest.fn(() => ({ getAdmissionPolicy: async () => policy() }));
    jest.doMock('mongoose', () => ({ Mongoose: jest.fn(() => client) }));
    jest.doMock('@librechat/data-schemas', () => ({
      createModels: models,
      createUploadManagementRepository: repository,
    }));
  });
  afterEach(() => {
    jest.dontMock('mongoose');
    jest.dontMock('@librechat/data-schemas');
    jest.resetModules();
  });

  test('owns a bounded Mongo client and checks actual topology before constructing the public facade', async () => {
    const runtime = await openRuntime(target, options, env);
    try {
      expect(client.connect).toHaveBeenCalledWith(
        env.MONGO_URI,
        expect.objectContaining({
          maxPoolSize: 2,
          minPoolSize: 0,
          maxConnecting: 1,
          autoIndex: false,
          autoCreate: false,
          bufferCommands: false,
          serverSelectionTimeoutMS: expect.any(Number),
          socketTimeoutMS: expect.any(Number),
        }),
      );
      for (const key of [
        'serverSelectionTimeoutMS',
        'connectTimeoutMS',
        'socketTimeoutMS',
        'waitQueueTimeoutMS',
      ]) {
        expect(client.connect.mock.calls[0][1][key]).toBeLessThanOrEqual(2000);
      }
      expect(models).toHaveBeenCalledWith(client);
      expect(repository).toHaveBeenCalledWith(client);
    } finally {
      await runtime.close();
    }
    expect(client.connection.close).toHaveBeenCalledWith(true);
  });

  test.each(['replica', 'database', 'independent'])(
    'refuses a wrong %s target without creating models',
    async (kind) => {
      if (kind === 'replica')
        client.connection.db.admin = () => ({ command: async () => ({ setName: 'other-rs' }) });
      if (kind === 'database') client.connection.name = 'OtherDatabase';
      if (kind === 'independent')
        env.CORTEX_UPLOAD_ADMISSION_TARGET = JSON.stringify({
          ...target,
          mongoDatabase: 'OtherDatabase',
        });
      await expect(openRuntime(target, options, env)).rejects.toMatchObject({
        code: 'TARGET_MISMATCH',
      });
      expect(models).not.toHaveBeenCalled();
      if (kind === 'independent') expect(client.connect).not.toHaveBeenCalled();
      else expect(client.connection.close).toHaveBeenCalledWith(true);
    },
  );
});
