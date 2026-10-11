/** Actual data methods with deferred adapters; no database server or account is required. */
import { createIndexesWithRetry } from '~/utils/retry';
import { createSessionMethods } from './session';
import { createUserMethods } from './user';

jest.mock('~/crypto', () => ({
  signPayload: jest.fn(async () => 'signed'),
  hashToken: jest.fn(async () => 'hashed'),
}));
jest.mock('~/utils/retry', () => ({ createIndexesWithRetry: jest.fn(async () => undefined) }));

test('a session caller joining shared index creation observes its pending and failed outcome', async () => {
  let fail!: (error: Error) => void;
  const pending = new Promise<void>((_resolve, reject) => {
    fail = reject;
  });
  jest.mocked(createIndexesWithRetry).mockReturnValueOnce(pending);
  const methods = createSessionMethods({ models: {} } as never);
  const first = methods.createSession('first').catch((error) => error);
  let active = 0;
  let failed = false;
  const observer = {
    write: async <T>(action: () => Promise<T>) => {
      active++;
      try {
        return await action();
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        active--;
      }
    },
  };
  const joined = methods.createSession('joined', {}, observer).catch((error) => error);
  expect(active).toBe(1);
  fail(new Error('index result unknown'));
  const outcomes = await Promise.all([first, joined]);
  expect(outcomes.every((outcome) => outcome instanceof Error)).toBe(true);
  expect(failed).toBe(true);
  expect(active).toBe(0);
});

test('user invalidation keeps every delete and reports the hidden failed mutation', async () => {
  const previous = process.env.AUTH_USER_CACHE_MODE;
  process.env.AUTH_USER_CACHE_MODE = 'on';
  let release!: () => void;
  const waiting = new Promise<boolean>((resolve) => {
    release = () => resolve(true);
  });
  const cache = {
    get: jest.fn(async () => ['one', 'two']),
    set: jest.fn(async () => undefined),
    delete: jest.fn((key: string) =>
      key === 'one' ? Promise.reject(new Error('unknown outcome')) : waiting,
    ),
  };
  const db = {
    models: { User: { findOneAndUpdate: () => ({ lean: async () => ({ _id: 'user' }) }) } },
  };
  const methods = createUserMethods(db as never, { getCache: () => cache });
  let failed = false;
  let finished = false;
  const observer = {
    write: async <T>(action: () => Promise<T>) => {
      try {
        return await action();
      } catch (error) {
        failed = true;
        throw error;
      }
    },
  };
  const work = methods.updateUser('user', {}, undefined, undefined, observer).then(() => {
    finished = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  try {
    expect(failed).toBe(true);
    expect(finished).toBe(false);
  } finally {
    release();
    await work;
    if (previous === undefined) delete process.env.AUTH_USER_CACHE_MODE;
    else process.env.AUTH_USER_CACHE_MODE = previous;
  }
});

test('session generation observes save only after signing and hashing have completed', async () => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const session = {
    user: 'user',
    _id: 'session',
    expiration: new Date(Date.now() + 100000),
    save: jest.fn(() => waiting),
  };
  const methods = createSessionMethods({ models: {} } as never);
  let observed = 0;
  const observer = {
    write: async <T>(action: () => Promise<T>) => {
      observed++;
      return action();
    },
  };
  const work = methods.generateRefreshToken(session as never, observer);
  await new Promise((resolve) => setImmediate(resolve));
  expect(observed).toBe(1);
  expect(session.save).toHaveBeenCalledTimes(1);
  release();
  await expect(work).resolves.toBe('signed');
});
