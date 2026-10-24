/** Owns Mongo Keyv facade/driver originals; Auth and shared Mongoose retain their lifecycles. */
import mongoose from 'mongoose';
import { EventEmitter } from 'events';
import { GridFSBucket } from 'mongodb';
import { logger } from '@librechat/data-schemas';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Db, ReadPreference, Collection } from 'mongodb';
import type { Keyv } from 'keyv';
import type { AuthMaintenance, AuthOperation } from '~/auth/maintenance';
import type { ApplicationWorkPort } from '~/app';

interface KeyvMongoOptions {
  url?: string;
  collection?: string;
  useGridFS?: boolean;
  readPreference?: ReadPreference;
}

interface GridFSClient {
  bucket: GridFSBucket;
  store: Collection;
  db: Db;
}

interface CollectionClient {
  store: Collection;
  db: Db;
}

type Client = GridFSClient | CollectionClient;

type CachePurpose = 'auth' | 'domains';
interface CacheOriginal {
  purpose: CachePurpose;
  auth?: AuthOperation;
  pending: number;
  promises: Set<PromiseLike<unknown>>;
}
const facadeMethods = [
  'get',
  'getMany',
  'getRaw',
  'getManyRaw',
  'set',
  'setMany',
  'delete',
  'deleteMany',
  'clear',
  'has',
  'hasMany',
  'disconnect',
] as const;

class KeyvMongoCustom extends EventEmitter {
  private opts: KeyvMongoOptions;
  public ttlSupport: boolean;
  public namespace?: string;

  private client?: Client;
  private auth?: AuthMaintenance;
  private context = new AsyncLocalStorage<CacheOriginal>();
  private facadeContext = new AsyncLocalStorage<{ original: CacheOriginal; active: boolean }>();
  private live = new Set<CacheOriginal>();
  private facades = new WeakMap<object, CachePurpose>();
  private drained = new Set<() => void>();
  private pause: string | null = null;
  private parentPause: string | null = null;
  private admittedAuth?: (operation: AuthOperation) => boolean;
  private stopped = false;
  private revision = 0;
  private writes = 0;
  private uncertain = false;

  private refuse() {
    return Object.assign(new Error('APP_QUIESCING'), { status: 503 });
  }

  private failed(original?: CacheOriginal) {
    this.uncertain = true;
    original?.auth?.markUncertain();
  }

  private current(purpose?: CachePurpose): CacheOriginal {
    const original = this.context.getStore();
    if (!original || !this.live.has(original) || (purpose && original.purpose !== purpose)) {
      if (original && !this.live.has(original)) this.failed(original);
      throw this.refuse();
    }
    return original;
  }

  private currentFacade(): CacheOriginal {
    const original = this.current();
    const frame = this.facadeContext.getStore();
    if (!frame?.active || frame.original !== original) {
      this.failed(original);
      throw this.refuse();
    }
    return original;
  }

  private invokeFacade<T>(action: () => T | Promise<T>): Promise<T> {
    const frame = { original: this.current(), active: true };
    return this.facadeContext.run(frame, async () => {
      try {
        return await action();
      } finally {
        frame.active = false;
      }
    });
  }

  private async retain<T>(original: CacheOriginal, action: () => T | Promise<T>): Promise<T> {
    if (!this.live.has(original)) {
      this.failed(original);
      throw this.refuse();
    }
    original.pending++;
    let promise: PromiseLike<unknown> | undefined;
    try {
      const result = this.context.run(original, action);
      if (result && typeof (result as PromiseLike<T>).then === 'function') {
        promise = result as PromiseLike<T>;
        original.promises.add(promise);
      }
      return await result;
    } catch (error) {
      this.failed(original);
      throw error;
    } finally {
      if (promise) original.promises.delete(promise);
      original.pending--;
      if (original.pending === 0) {
        this.live.delete(original);
        if (this.live.size === 0) {
          this.drained.forEach((resolve) => resolve());
          this.drained.clear();
        }
      }
    }
  }

  private begin<T>(purpose: CachePurpose, action: () => T | Promise<T>, auth?: AuthOperation) {
    if ((this.stopped || this.pause !== null) && !auth) return Promise.reject(this.refuse());
    const original: CacheOriginal = { purpose, auth, pending: 0, promises: new Set() };
    this.live.add(original);
    return this.retain(original, action);
  }

  /** Fixed composition binding, not a caller-supplied continuation token. */
  bindAuth(owner: AuthMaintenance): void {
    if (this.auth === owner) return;
    if (this.auth || this.pause !== null || this.stopped || this.live.size !== 0) {
      this.failed();
      throw new Error('Mongo cache Auth binding is already fixed or active');
    }
    this.auth = owner;
  }

  private async facade<T>(purpose: CachePurpose, action: () => T | Promise<T>): Promise<T> {
    const existing = this.context.getStore();
    if (this.facadeContext.getStore()?.active === false) {
      this.failed(existing);
      throw this.refuse();
    }
    if (existing) {
      const original = this.current(purpose);
      // Every nested Keyv child retains Auth through serialization and an early sibling rejection.
      return original.auth
        ? original.auth.track(() => this.retain(original, action))
        : this.retain(original, action);
    }
    if (purpose !== 'auth' || !this.auth) throw this.refuse();
    const parent = this.auth.current();
    if (
      (this.stopped || this.pause !== null) &&
      (!parent ||
        (this.pause !== null &&
          (this.parentPause !== this.pause || this.admittedAuth?.(parent) !== true)))
    )
      throw this.refuse();
    return this.auth.run(undefined, (operation) => {
      if (parent && parent !== operation) throw this.refuse();
      return this.begin(purpose, action, operation);
    });
  }

  /** Bind the real facade before exposing it; retain hooks, serialization and expiry deletion. */
  bindFacade<T extends Keyv>(facade: T, purpose: CachePurpose): T {
    if (facade.store !== this || !['auth', 'domains'].includes(purpose) || this.opts.useGridFS) {
      throw new Error('Unsupported Mongo Keyv facade binding');
    }
    const existing = this.facades.get(facade);
    if (existing) {
      if (existing !== purpose) throw new Error('Mongo Keyv facade purpose is already fixed');
      return facade;
    }
    this.facades.set(facade, purpose);
    facade.on('error', () => this.failed(this.context.getStore()));
    for (const name of facadeMethods) {
      const method = facade[name];
      if (typeof method !== 'function') throw new Error(`Missing Keyv method: ${name}`);
      const invoke = (receiver: Keyv, args: unknown[]) => {
        if (
          receiver !== facade ||
          (facade.store as unknown) !== this ||
          (facade.opts.store as unknown) !== this
        ) {
          this.failed();
          return Promise.reject(this.refuse());
        }
        return this.facade(purpose, () =>
          this.invokeFacade(() => Reflect.apply(method, receiver, args)),
        );
      };
      Object.defineProperty(facade, name, {
        configurable: true,
        writable: true,
        value: function (this: Keyv, ...args: unknown[]) {
          return invoke(this, args);
        },
      });
    }
    return facade;
  }

  /** Only the actual encoded-domain producer opens this original. */
  runDomainParser<T>(action: () => T | Promise<T>): Promise<T> {
    if (this.context.getStore()) return this.retain(this.current('domains'), action);
    return this.begin('domains', action);
  }

  /** Driver observation precedes Keyv's false/undefined normalization. */
  private driver<T>(write: boolean, action: () => Promise<T>): Promise<T> {
    const original = this.currentFacade();
    const dispatch = async () => {
      this.currentFacade();
      if (
        !this.client ||
        this.client.db !== mongoose.connection.db ||
        mongoose.connection.readyState !== 1
      ) {
        this.failed(original);
        throw new Error('Original Mongo cache connection is unavailable or replaced');
      }
      if (write) this.writes++;
      try {
        return await this.retain(original, action);
      } finally {
        if (write) this.writes--;
        if (this.client?.db !== mongoose.connection.db || mongoose.connection.readyState !== 1) {
          this.failed(original);
        }
      }
    };
    return original.auth
      ? (write ? original.auth.write : original.auth.track)(dispatch)
      : dispatch();
  }

  readonly maintenance: ApplicationWorkPort = {
    pauseAdmissions: (id) => {
      if (
        typeof id !== 'string' ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(id) ||
        (this.pause !== null && this.pause !== id)
      )
        return false;
      if (this.pause !== id) {
        this.pause = id;
        this.revision++;
        // Capture before the first parent ACK attempt; later ACKs cannot admit gap originals.
        this.admittedAuth = this.auth?.snapshotAdmissions();
      }
      // Close the actual parent too, so a new Auth root cannot bypass a cache-only pause.
      const accepted =
        this.auth?.pauseAdmissions(id) === true && typeof this.admittedAuth === 'function';
      this.parentPause = accepted ? id : null;
      return accepted;
    },
    resumeAdmissions: (id) => {
      if (this.stopped || this.pause !== id || this.uncertain) return false;
      this.pause = null;
      this.parentPause = null;
      this.admittedAuth = undefined;
      this.revision++;
      // App composition separately resumes Auth; this child never reopens its parent.
      return true;
    },
    getMaintenanceCensus: async (id) => {
      const sampled = this.revision;
      const matches = id === this.pause;
      const parent = await this.auth?.getMaintenanceCensus(id);
      const closed = this.stopped || this.pause !== null;
      if (
        this.client &&
        (this.client.db !== mongoose.connection.db || mongoose.connection.readyState !== 1)
      )
        this.failed();
      return {
        admissionClosed: closed,
        queuedContinuations: this.live.size + (parent?.queuedContinuations ?? 0),
        pendingWrites: this.writes + (parent?.pendingWrites ?? 0),
        complete:
          matches &&
          id === this.pause &&
          sampled === this.revision &&
          !this.uncertain &&
          !this.opts.useGridFS &&
          parent?.complete === true &&
          parent.admissionClosed === closed,
      };
    },
  };

  stopAdmissions(): void {
    if (!this.stopped) {
      this.stopped = true;
      this.revision++;
    }
    this.auth?.stopAdmissions();
  }

  async drain(): Promise<void> {
    this.stopAdmissions();
    try {
      if (!this.auth) throw new Error('Mongo cache Auth binding is missing');
      await this.auth.drain();
    } catch {
      this.failed();
    }
    // Auth may have admitted its last cache child while its original was draining.
    if (this.live.size !== 0) await new Promise<void>((resolve) => this.drained.add(resolve));
    if (this.uncertain || this.opts.useGridFS)
      throw new Error('MONGO_CACHE_SETTLEMENT_UNCONFIRMED');
  }

  constructor(options: KeyvMongoOptions = {}) {
    super();

    this.opts = {
      url: 'mongodb://127.0.0.1:27017',
      collection: 'keyv',
      ...options,
    };

    this.ttlSupport = false;
  }

  // Every dispatch remains bound to the original shared connection's actual Db object.
  private async _getClient(): Promise<Client> {
    const original = this.currentFacade();
    if (
      mongoose.connection.readyState !== 1 ||
      (this.client && this.client.db !== mongoose.connection.db)
    ) {
      this.failed(original);
      throw new Error('Original Mongo cache connection is unavailable or replaced');
    }
    if (this.client) return this.client;

    try {
      const db = mongoose.connection.db as unknown as Db | undefined;
      if (!db) {
        throw new Error('MongoDB database not available');
      }

      let client: Client;

      if (this.opts.useGridFS) {
        const bucket = new GridFSBucket(db, {
          readPreference: this.opts.readPreference,
          bucketName: this.opts.collection,
        });
        const store = db.collection(`${this.opts.collection}.files`);
        client = { bucket, store, db };
      } else {
        const collection = this.opts.collection || 'keyv';
        const store = db.collection(collection);
        client = { store, db };
      }

      this.client = client;
      return client;
    } catch (error) {
      this.failed(original);
      this.emit('error', error);
      throw error;
    }
  }

  async get(key: string): Promise<unknown> {
    const client = await this._getClient();

    if (this.opts.useGridFS && this.isGridFSClient(client)) {
      await client.store.updateOne(
        {
          filename: key,
        },
        {
          $set: {
            'metadata.lastAccessed': new Date(),
          },
        },
      );

      const stream = client.bucket.openDownloadStreamByName(key);

      return new Promise((resolve) => {
        const resp: Uint8Array[] = [];
        stream.on('error', () => {
          resolve(undefined);
        });

        stream.on('end', () => {
          const data = Buffer.concat(resp).toString('utf8');
          resolve(data);
        });

        stream.on('data', (chunk: Uint8Array) => {
          resp.push(chunk);
        });
      });
    }

    const document = await this.driver(false, () => client.store.findOne({ key: { $eq: key } }));

    if (!document) {
      return undefined;
    }

    return document.value;
  }

  async getMany(keys: string[]): Promise<unknown[]> {
    const client = await this._getClient();

    if (this.opts.useGridFS) {
      const promises = [];
      for (const key of keys) {
        promises.push(this.get(key));
      }

      const values = await Promise.allSettled(promises);
      const data: unknown[] = [];
      for (const value of values) {
        data.push(value.status === 'fulfilled' ? value.value : undefined);
      }

      return data;
    }

    const values = await this.driver(false, () =>
      client.store
        .find({ key: { $in: keys } })
        .project({ _id: 0, value: 1, key: 1 })
        .toArray(),
    );

    const results: unknown[] = [...keys];
    let i = 0;
    for (const key of keys) {
      const rowIndex = values.findIndex((row) => row.key === key);
      results[i] = rowIndex > -1 ? values[rowIndex].value : undefined;
      i++;
    }

    return results;
  }

  async set(key: string, value: string, ttl?: number): Promise<unknown> {
    const client = await this._getClient();
    const expiresAt = typeof ttl === 'number' ? new Date(Date.now() + ttl) : null;

    if (this.opts.useGridFS && this.isGridFSClient(client)) {
      const stream = client.bucket.openUploadStream(key, {
        metadata: {
          expiresAt,
          lastAccessed: new Date(),
        },
      });

      return new Promise((resolve) => {
        stream.on('finish', () => {
          resolve(stream);
        });
        stream.end(value);
      });
    }

    await this.driver(true, () =>
      client.store.updateOne(
        { key: { $eq: key } },
        { $set: { key, value, expiresAt } },
        { upsert: true },
      ),
    );
  }

  async delete(key: string): Promise<boolean> {
    const client = await this._getClient();

    if (this.opts.useGridFS && this.isGridFSClient(client)) {
      try {
        const bucket = new GridFSBucket(client.db, {
          bucketName: this.opts.collection,
        });
        const files = await bucket.find({ filename: key }).toArray();
        if (files.length > 0) {
          await client.bucket.delete(files[0]._id);
        }
        return true;
      } catch {
        return false;
      }
    }

    const object = await this.driver(true, () => client.store.deleteOne({ key: { $eq: key } }));
    return object.deletedCount > 0;
  }

  async deleteMany(keys: string[]): Promise<boolean> {
    const client = await this._getClient();

    if (this.opts.useGridFS && this.isGridFSClient(client)) {
      const bucket = new GridFSBucket(client.db, {
        bucketName: this.opts.collection,
      });
      const files = await bucket.find({ filename: { $in: keys } }).toArray();
      if (files.length === 0) {
        return false;
      }

      await Promise.all(files.map(async (file) => client.bucket.delete(file._id)));
      return true;
    }

    const object = await this.driver(true, () => client.store.deleteMany({ key: { $in: keys } }));
    return object.deletedCount > 0;
  }

  async clear(): Promise<void> {
    const client = await this._getClient();

    if (this.opts.useGridFS && this.isGridFSClient(client)) {
      try {
        await client.bucket.drop();
      } catch (error: unknown) {
        // Throw error if not "namespace not found" error
        const errorCode =
          error instanceof Error && 'code' in error ? (error as { code?: number }).code : undefined;
        if (errorCode !== 26) {
          throw error;
        }
      }
    }

    await this.driver(true, () =>
      client.store.deleteMany({
        key: { $regex: this.namespace ? `^${this.namespace}:*` : '' },
      }),
    );
  }

  async has(key: string): Promise<boolean> {
    const client = await this._getClient();
    const filter = { [this.opts.useGridFS ? 'filename' : 'key']: { $eq: key } };
    const document = await this.driver(false, () =>
      client.store.countDocuments(filter, { limit: 1 }),
    );
    return document !== 0;
  }

  // No-op disconnect
  async disconnect(): Promise<boolean> {
    // This is a no-op since we don't want to close the shared mongoose connection
    this.currentFacade();
    return true;
  }

  private isGridFSClient(client: Client): client is GridFSClient {
    return (client as GridFSClient).bucket != null;
  }
}

const keyvMongo: KeyvMongoCustom = new KeyvMongoCustom({
  collection: 'logs',
});

keyvMongo.on('error', (err) => logger.error('KeyvMongo connection error:', err));

/** Fixed public composition ports; the singleton remains the sole adapter/lifecycle owner. */
export const mongoCacheMaintenance: KeyvMongoCustom = keyvMongo;
export const ownMongoCache = <T extends Keyv>(facade: T, purpose: CachePurpose): T =>
  keyvMongo.bindFacade(facade, purpose);
export const runMongoDomainParser = <T>(action: () => T | Promise<T>): Promise<T> =>
  keyvMongo.runDomainParser(action);

export default keyvMongo;
