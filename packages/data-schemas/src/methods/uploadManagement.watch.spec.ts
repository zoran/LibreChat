/** Real change-stream tenant filtering, metadata projection and bounded lifecycle closure. */
import mongoose from 'mongoose';
import { EventEmitter } from 'node:events';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { createUploadManagementRepository } from './uploadManagement';
import { createModels } from '~/models';

function next<T>(
  source: EventEmitter,
  event: string,
  predicate: (value: T) => boolean = () => true,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      source.off(event, receive);
      reject(new Error(`Missing isolated ${event} event`));
    }, 3000);
    function receive(value: T) {
      if (!predicate(value)) return;
      clearTimeout(timer);
      source.off(event, receive);
      resolve(value);
    }
    source.on(event, receive);
  });
}

describe('tenant-bound upload change stream', () => {
  let mongo: MongoMemoryReplSet;
  const a = new mongoose.Mongoose();
  const b = new mongoose.Mongoose();
  let repository: ReturnType<typeof createUploadManagementRepository>;
  const stops: (() => Promise<void>)[] = [];
  const tenantId = 'tenant-a';
  const owner = { tenantId, userId: 'same-user' };

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await Promise.all([
      a.connect(mongo.getUri('watch'), { monitorCommands: true }),
      b.connect(mongo.getUri('watch')),
    ]);
    for (const db of [a, b]) createModels(db);
    repository = createUploadManagementRepository(a);
    const writer = createUploadManagementRepository(b);
    await repository.initialize();
    await writer.initialize();
  });
  beforeEach(async () => {
    await a.models.UploadOperation.deleteMany({});
  });
  afterEach(async () => {
    for (const stop of stops.splice(0)) await stop();
    jest.restoreAllMocks();
  });
  afterAll(async () => {
    await Promise.all([a.disconnect(), b.disconnect()]);
    await mongo?.stop();
  });

  async function watch() {
    const signals = new EventEmitter();
    const changed = jest.fn((principal: typeof owner) => signals.emit('owner', principal));
    const reset = jest.fn(() => signals.emit('reset', undefined));
    const observed: Record<string, unknown>[] = [];
    const factory = jest.spyOn(a.models.UploadOperation, 'watch');
    const ready = next<{ commandName: string }>(
      a.connection.getClient(),
      'commandSucceeded',
      (event) => event.commandName === 'aggregate',
    );
    const close = repository.watchChanges({ tenantId, onChanged: changed, onReset: reset });
    const stream = factory.mock.results[0].value;
    stream.on('change', (event: Record<string, unknown>) => {
      observed.push(event);
      signals.emit('raw', event);
    });
    const stop = async () => {
      close();
      await stream.close();
    };
    stops.push(stop);
    await ready;
    return { signals, changed, reset, observed, stop };
  }

  async function insert(id: string, tenant = tenantId) {
    await b.models.UploadOperation.create({
      _id: id,
      tenantId: tenant,
      userId: owner.userId,
      filename: 'private-document-name',
      original: { storageKey: 'private-original-key' },
    });
  }

  it('rejects an absent or malformed configured tenant without opening a stream', () => {
    const factory = jest.spyOn(a.models.UploadOperation, 'watch');
    for (const invalid of [undefined, null, '', {}, 'a'.repeat(129)]) {
      expect(() =>
        repository.watchChanges({
          tenantId: invalid as string,
          onChanged: jest.fn(),
          onReset: jest.fn(),
        }),
      ).toThrow(expect.objectContaining({ code: 'invalid_request' }));
    }
    expect(factory).not.toHaveBeenCalled();
  });

  it('never emits another tenant document or a reset for it, even with the same user identifier', async () => {
    const f = await watch();
    const routed = next<typeof owner>(f.signals, 'owner');
    await insert('foreign', 'tenant-b');
    await insert('local-barrier');
    await routed;
    expect(f.changed.mock.calls).toEqual([[owner]]);
    expect(f.reset).not.toHaveBeenCalled();
    expect(f.observed).toHaveLength(1);
    expect(f.observed[0].fullDocument).toEqual(owner);
  });

  it('projects only routing identity before the driver receives the change', async () => {
    const f = await watch();
    const raw = next<Record<string, unknown>>(f.signals, 'raw');
    await insert('projected');
    const change = await raw;
    expect(Object.keys(change).sort()).toEqual(['_id', 'fullDocument', 'operationType']);
    expect(change.fullDocument).toEqual(owner);
    expect(JSON.stringify(change)).not.toContain('private-');
    expect(change).not.toHaveProperty('documentKey');
    expect(change).not.toHaveProperty('updateDescription');
  });

  it('emits only a reset when a deleted document has no safely routable tenant', async () => {
    const f = await watch();
    const routed = next<typeof owner>(f.signals, 'owner');
    await insert('delete-me');
    await routed;
    f.changed.mockClear();
    f.observed.length = 0;
    const reset = next(f.signals, 'reset');
    await b.models.UploadOperation.deleteOne({ _id: 'delete-me' });
    await reset;
    expect(f.changed).not.toHaveBeenCalled();
    expect(f.reset).toHaveBeenCalledTimes(1);
    expect(f.observed).toHaveLength(1);
    expect(Object.keys(f.observed[0]).sort()).toEqual(['_id', 'operationType']);
  });

  it('closes the exact watch without reset callbacks or later events', async () => {
    const f = await watch();
    await f.stop();
    await insert('after-close');
    expect(f.changed).not.toHaveBeenCalled();
    expect(f.reset).not.toHaveBeenCalled();
    expect(f.observed).toHaveLength(0);
  });

  it('preserves collection invalidation as a data-free system reset', async () => {
    const f = await watch();
    const reset = next(f.signals, 'reset');
    await b.models.UploadOperation.collection.drop();
    await reset;
    expect(f.reset).toHaveBeenCalled();
    expect(f.changed).not.toHaveBeenCalled();
    for (const change of f.observed) {
      expect(['drop', 'invalidate']).toContain(change.operationType);
      expect(Object.keys(change).sort()).toEqual(['_id', 'operationType']);
    }
  });
});
