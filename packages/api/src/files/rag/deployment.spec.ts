import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { loadManagedFileDeploymentConfiguration, MANAGED_FILE_DEPLOYMENT_PATH } from './deployment';
import { configurationFixture } from './configuration.fixture';

jest.mock('node:fs/promises', () => ({
  ...jest.requireActual('node:fs/promises'),
  open: jest.fn(),
}));
const realOpen: typeof open = jest.requireActual('node:fs/promises').open;
const unavailable = {
  message: 'Managed retrieval configuration unavailable',
  code: 'managed_retrieval_configuration_unavailable',
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function file(bytes: Buffer) {
  return {
    stat: jest.fn(async () => ({ isFile: (): boolean => true, size: bytes.length })),
    read: jest.fn(async (buffer: Buffer, offset: number, length: number, position: number) => {
      const bytesRead = Math.min(length, Math.max(0, bytes.length - position));
      bytes.copy(buffer, offset, position, position + bytesRead);
      return { bytesRead, buffer };
    }),
    close: jest.fn(async () => undefined),
  };
}
beforeEach(() => jest.mocked(open).mockReset());
afterEach(() => jest.restoreAllMocks());

it('allows optional web absence without independently supplied expectations', async () => {
  const onFailure = jest.fn();
  jest.mocked(open).mockRejectedValue(Object.assign(new Error('absent'), { code: 'ENOENT' }));
  await expect(
    loadManagedFileDeploymentConfiguration({
      mode: 'optional',
      signal: new AbortController().signal,
      onFailure,
    }),
  ).resolves.toBeUndefined();
  expect(open).toHaveBeenCalledTimes(1);
  expect(onFailure).not.toHaveBeenCalled();
});

it('rejects present optional web input without expectations before reading and retains original close', async () => {
  const handle = file(configurationFixture().bytes);
  const closing = deferred<undefined>();
  handle.close.mockImplementation(() => closing.promise);
  jest.mocked(open).mockResolvedValue(handle as unknown as FileHandle);
  const onFailure = jest.fn();
  const original = loadManagedFileDeploymentConfiguration({
    mode: 'optional',
    signal: new AbortController().signal,
    onFailure,
  });
  let settled = false;
  void original.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  try {
    await tick();
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining(unavailable));
    expect(handle.stat).not.toHaveBeenCalled();
    expect(handle.read).not.toHaveBeenCalled();
    expect(handle.close).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
  } finally {
    closing.resolve(undefined);
  }
  await expect(original).rejects.toMatchObject(unavailable);
});

it('keeps optional web absence probing under original abort and late descriptor custody', async () => {
  const opening = deferred<FileHandle>();
  const closing = deferred<undefined>();
  const handle = file(configurationFixture().bytes);
  handle.close.mockImplementation(() => closing.promise);
  jest.mocked(open).mockReturnValue(opening.promise);
  const controller = new AbortController();
  const reason = new Error('Original optional acquisition cancelled');
  const original = loadManagedFileDeploymentConfiguration({
    mode: 'optional',
    signal: controller.signal,
  });
  let settled = false;
  void original.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  controller.abort(reason);
  try {
    await tick();
    expect(settled).toBe(false);
    opening.resolve(handle as unknown as FileHandle);
    await tick();
    expect(handle.read).not.toHaveBeenCalled();
    expect(handle.close).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
  } finally {
    opening.resolve(handle as unknown as FileHandle);
    closing.resolve(undefined);
  }
  await expect(original).rejects.toBe(reason);
});

it('keeps required mode strict when optional web absence can omit expectations', async () => {
  await expect(
    loadManagedFileDeploymentConfiguration({
      mode: 'required',
      signal: new AbortController().signal,
      expected: undefined as unknown as ReturnType<typeof configurationFixture>['expected'],
    }),
  ).rejects.toMatchObject(unavailable);
  expect(open).not.toHaveBeenCalled();
});

/** Only filesystem acquisition is substituted; real file bytes, File validators and loader execute. */
it('reads the fixed path once, closes the real descriptor, and returns the immutable configuration', async () => {
  const fixture = configurationFixture();
  const directory = await mkdtemp(join(tmpdir(), 'retrieval-config-'));
  const path = join(directory, 'managed-file.json');
  let descriptor: FileHandle | undefined;
  try {
    await writeFile(path, fixture.bytes, { mode: 0o600 });
    jest.mocked(open).mockImplementation(async (requested, flags) => {
      expect(requested).toBe(MANAGED_FILE_DEPLOYMENT_PATH);
      expect(flags).toBe('r');
      descriptor = await realOpen(path, flags);
      return descriptor;
    });
    const value = await loadManagedFileDeploymentConfiguration({
      expected: fixture.expected,
      signal: new AbortController().signal,
      mode: 'required',
    });
    expect(value).toEqual(fixture.input.trustedFile);
    expect(Object.isFrozen(value.retrieval!.policySnapshot.content)).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
    expect(descriptor!.fd).toBe(-1);
  } finally {
    await descriptor?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('allows only ENOENT at the optional web boundary; required cleanup and other failures reject', async () => {
  const { expected } = configurationFixture();
  const options = { expected, signal: new AbortController().signal };
  jest.mocked(open).mockRejectedValue(Object.assign(new Error('private path'), { code: 'ENOENT' }));
  await expect(
    loadManagedFileDeploymentConfiguration({ ...options, mode: 'optional' }),
  ).resolves.toBeUndefined();
  await expect(
    loadManagedFileDeploymentConfiguration({ ...options, mode: 'required' }),
  ).rejects.toMatchObject(unavailable);
  jest.mocked(open).mockRejectedValue(Object.assign(new Error('private path'), { code: 'EACCES' }));
  await expect(
    loadManagedFileDeploymentConfiguration({ ...options, mode: 'optional' }),
  ).rejects.toMatchObject(unavailable);
  const handle = file(Buffer.from('invalid mounted content'));
  jest.mocked(open).mockResolvedValue(handle as unknown as FileHandle);
  await expect(
    loadManagedFileDeploymentConfiguration({ ...options, mode: 'optional' }),
  ).rejects.toMatchObject(unavailable);
  expect(handle.close).toHaveBeenCalledTimes(1);
});

it('rejects pre-abort and invalid expectations before opening a file', async () => {
  const { expected } = configurationFixture();
  const controller = new AbortController();
  const reason = new Error('Original startup cancelled');
  controller.abort(reason);
  await expect(
    loadManagedFileDeploymentConfiguration({
      expected,
      signal: controller.signal,
      mode: 'required',
    }),
  ).rejects.toBe(reason);
  await expect(
    loadManagedFileDeploymentConfiguration({
      expected: { ...expected, configurationSha256: '' },
      signal: new AbortController().signal,
      mode: 'required',
    }),
  ).rejects.toMatchObject(unavailable);
  expect(open).not.toHaveBeenCalled();
});

it('retains a held open original after abort, then closes its late handle before rejecting', async () => {
  const fixture = configurationFixture();
  const opening = deferred<FileHandle>();
  const closing = deferred<undefined>();
  const handle = file(fixture.bytes);
  handle.close.mockImplementation(() => closing.promise);
  jest.mocked(open).mockReturnValue(opening.promise);
  const controller = new AbortController();
  const reason = new Error('Original startup cancelled');
  const original = loadManagedFileDeploymentConfiguration({
    expected: fixture.expected,
    signal: controller.signal,
    mode: 'required',
  });
  let settled = false;
  void original.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  controller.abort(reason);
  await tick();
  expect(settled).toBe(false);
  opening.resolve(handle as unknown as FileHandle);
  await tick();
  expect(handle.stat).not.toHaveBeenCalled();
  expect(handle.read).not.toHaveBeenCalled();
  expect(handle.close).toHaveBeenCalledTimes(1);
  expect(settled).toBe(false);
  closing.resolve(undefined);
  await expect(original).rejects.toBe(reason);
});

it('retains the exact held read and close originals instead of detaching them on deadline', async () => {
  const fixture = configurationFixture();
  const reading = deferred<{ bytesRead: number; buffer: Buffer }>();
  const closing = deferred<undefined>();
  const handle = file(fixture.bytes);
  handle.read.mockImplementation(() => reading.promise);
  handle.close.mockImplementation(() => closing.promise);
  jest.mocked(open).mockResolvedValue(handle as unknown as FileHandle);
  const controller = new AbortController();
  const reason = new Error('Original acquisition deadline');
  const original = loadManagedFileDeploymentConfiguration({
    expected: fixture.expected,
    signal: controller.signal,
    mode: 'required',
  });
  let settled = false;
  void original.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await tick();
  expect(handle.read).toHaveBeenCalledTimes(1);
  controller.abort(reason);
  await tick();
  expect(settled).toBe(false);
  expect(handle.close).not.toHaveBeenCalled();
  reading.resolve({ bytesRead: 0, buffer: Buffer.alloc(0) });
  await tick();
  expect(handle.close).toHaveBeenCalledTimes(1);
  expect(settled).toBe(false);
  closing.resolve(undefined);
  await expect(original).rejects.toBe(reason);
  expect(handle.read).toHaveBeenCalledTimes(1);
});

it('does not release parsed configuration when cancellation arrives during original close', async () => {
  const fixture = configurationFixture();
  const closing = deferred<undefined>();
  const handle = file(fixture.bytes);
  handle.close.mockImplementation(() => closing.promise);
  jest.mocked(open).mockResolvedValue(handle as unknown as FileHandle);
  const controller = new AbortController();
  const original = loadManagedFileDeploymentConfiguration({
    expected: fixture.expected,
    signal: controller.signal,
    mode: 'required',
  });
  let settled = false;
  void original.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await tick();
  expect(handle.close).toHaveBeenCalledTimes(1);
  const reason = new Error('Shutdown during close');
  controller.abort(reason);
  await tick();
  expect(settled).toBe(false);
  closing.resolve(undefined);
  await expect(original).rejects.toBe(reason);
});

it.each(['stat', 'read', 'parse'] as const)(
  'notifies the first %s failure before pending close and preserves it through shutdown',
  async (fault) => {
    const fixture = configurationFixture();
    const closing = deferred<undefined>();
    const handle = file(fault === 'parse' ? Buffer.from('invalid configuration') : fixture.bytes);
    if (fault === 'stat') handle.stat.mockRejectedValue(new Error('private stat diagnostic'));
    if (fault === 'read') handle.read.mockRejectedValue(new Error('private read diagnostic'));
    handle.close.mockImplementation(() => closing.promise);
    jest.mocked(open).mockResolvedValue(handle as unknown as FileHandle);
    const controller = new AbortController();
    const onFailure = jest.fn((error: unknown) => {
      expect(error).toMatchObject(unavailable);
      controller.abort(new Error('Startup failure requested shutdown'));
      throw new Error('Notification callback cannot skip cleanup');
    });
    let settled = false;
    const original = loadManagedFileDeploymentConfiguration({
      expected: fixture.expected,
      signal: controller.signal,
      mode: 'required',
      onFailure,
    });
    const outcome = original.then(
      () => {
        settled = true;
        return undefined;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    try {
      await tick();
      expect(onFailure).toHaveBeenCalledTimes(1);
      expect(handle.close).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
    } finally {
      closing.reject(new Error('Later close diagnostic'));
      await outcome;
    }
    expect(await outcome).toBe(onFailure.mock.calls[0][0]);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(handle.close).toHaveBeenCalledTimes(1);
  },
);

it('notifies acquisition failure once but accepts optional absence without notification', async () => {
  const fixture = configurationFixture();
  const onFailure = jest.fn();
  const options = {
    expected: fixture.expected,
    signal: new AbortController().signal,
    mode: 'optional' as const,
    onFailure,
  };
  jest.mocked(open).mockRejectedValue(Object.assign(new Error('private path'), { code: 'ENOENT' }));
  await expect(loadManagedFileDeploymentConfiguration(options)).resolves.toBeUndefined();
  expect(onFailure).not.toHaveBeenCalled();
  jest.mocked(open).mockRejectedValue(Object.assign(new Error('private path'), { code: 'EACCES' }));
  const failure = await loadManagedFileDeploymentConfiguration(options).catch(
    (error: unknown) => error,
  );
  expect(failure).toMatchObject(unavailable);
  expect(onFailure).toHaveBeenCalledTimes(1);
  expect(onFailure).toHaveBeenCalledWith(failure);
});

it('captures independent expectations and the original signal before the first asynchronous boundary', async () => {
  const fixture = configurationFixture();
  const opening = deferred<FileHandle>();
  jest.mocked(open).mockReturnValue(opening.promise);
  const controller = new AbortController();
  const expected = { ...fixture.expected };
  const options = { expected, signal: controller.signal, mode: 'required' as const };
  const original = loadManagedFileDeploymentConfiguration(options);
  expected.sourceRevision = 'f'.repeat(40);
  expected.configurationSha256 = '0'.repeat(64);
  options.signal = new AbortController().signal;
  opening.resolve(file(fixture.bytes) as unknown as FileHandle);
  await expect(original).resolves.toEqual(fixture.input.trustedFile);

  const secondOpen = deferred<FileHandle>();
  jest.mocked(open).mockReturnValue(secondOpen.promise);
  const second = {
    expected: fixture.expected,
    signal: controller.signal,
    mode: 'required' as const,
  };
  const interrupted = loadManagedFileDeploymentConfiguration(second);
  const reason = new Error('Original signal wins');
  second.signal = new AbortController().signal;
  controller.abort(reason);
  secondOpen.resolve(file(fixture.bytes) as unknown as FileHandle);
  await expect(interrupted).rejects.toBe(reason);
});

it.each(['directory', 'oversized', 'growing', 'read', 'close'] as const)(
  'closes owned resources and fails safely for %s input',
  async (fault) => {
    const fixture = configurationFixture();
    const handle = file(fault === 'growing' ? Buffer.alloc(65_537) : fixture.bytes);
    if (fault === 'directory') handle.stat.mockResolvedValue({ isFile: () => false, size: 0 });
    if (fault === 'oversized') handle.stat.mockResolvedValue({ isFile: () => true, size: 65_537 });
    if (fault === 'growing') handle.stat.mockResolvedValue({ isFile: () => true, size: 1 });
    if (fault === 'read') handle.read.mockRejectedValue(new Error('private read diagnostic'));
    if (fault === 'close') handle.close.mockRejectedValue(new Error('private close diagnostic'));
    jest.mocked(open).mockResolvedValue(handle as unknown as FileHandle);
    await expect(
      loadManagedFileDeploymentConfiguration({
        expected: fixture.expected,
        signal: new AbortController().signal,
        mode: 'required',
      }),
    ).rejects.toMatchObject(unavailable);
    expect(handle.close).toHaveBeenCalledTimes(1);
    if (fault === 'directory' || fault === 'oversized') expect(handle.read).not.toHaveBeenCalled();
    if (fault === 'growing') {
      expect(handle.read).toHaveBeenCalledTimes(1);
      expect(handle.read.mock.calls[0][2]).toBe(65_537);
    }
  },
);
