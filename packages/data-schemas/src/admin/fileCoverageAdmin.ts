/** Fixed Pod admin half of the authenticated native broker/executor composition.
 * Frames correlate the owned exec stream; they are not portable native authority.
 * The broker must hold the real invocation and original writer/timer exclusion until
 * this process closes Mongo, returns its terminal frame and exits successfully.
 */
import { Mongoose } from 'mongoose';
import { readFileSync } from 'node:fs';
import { TextDecoder } from 'node:util';
import {
  FILE_HOUSEKEEPING_COVERAGE_CONTRACT,
  FILE_HOUSEKEEPING_INVENTORY_CONTRACT,
} from 'librechat-data-provider';
import type {
  FileCoverageAction,
  FileCoverageRun,
  FileCoverageResult,
  FileInventoryRequest,
  FileInventoryResult,
} from 'librechat-data-provider';
import type { Readable, Writable } from 'node:stream';
import type { FileCoverageNativeProducer } from '../methods/fileHousekeepingCoverage';
import {
  isFileCoverageAction,
  isFileInventoryRequest,
  fileCoverageDigest,
  sameFileCoverageData,
} from '../methods/fileHousekeepingCoverageContract';
import {
  createFileHousekeepingCoverageMethods,
  inspectFileHousekeepingInventory,
} from '../methods/fileHousekeepingCoverage';
import { createUploadStore } from '../methods/uploadManagementStore';
import { createFileModel } from '../models/file';

const LIMIT = 16_384;
const TOTAL = 262_144;
const PROCESS_MS = 10_000;
type CoverageOpening = {
  kind: 'open';
  seq: 0;
  podUid: string;
  run: FileCoverageRun;
  action: FileCoverageAction;
};
type InventoryOpening = {
  kind: 'inventory';
  seq: 0;
  podUid: string;
  request: FileInventoryRequest;
};
type Opening = CoverageOpening | InventoryOpening;

function requireValue(value: unknown): asserts value {
  if (!value) throw new Error('COVERAGE_ADMIN_UNAVAILABLE');
}
function shape(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

/** No queued grants, EOF-as-success, unbounded lines, or detached pending reads. */
class Channel {
  private bytes = Buffer.alloc(0);
  private total = 0;
  private failure: Error | undefined;
  private waiting: { resolve(value: unknown): void; reject(error: Error): void } | undefined;
  constructor(
    private input: Readable,
    private output: Writable,
    private abort: AbortController,
  ) {
    input.on('data', this.data);
    input.on('end', this.failed);
    input.on('close', this.failed);
    input.on('error', this.failed);
    output.on('error', this.failed);
    abort.signal.addEventListener('abort', this.failed);
  }
  private failed = (): void => {
    if (this.failure) return;
    this.failure = new Error('COVERAGE_CHANNEL_LOST');
    this.waiting?.reject(this.failure);
    this.waiting = undefined;
    this.abort.abort();
  };
  private data = (part: Buffer | string): void => {
    try {
      const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
      this.total += chunk.length;
      requireValue(this.total <= TOTAL);
      this.bytes = Buffer.concat([this.bytes, chunk]);
      let newline: number;
      while ((newline = this.bytes.indexOf(10)) !== -1) {
        requireValue(newline > 0 && newline <= LIMIT && this.waiting && !this.failure);
        const value: unknown = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(this.bytes.subarray(0, newline)),
        );
        this.bytes = this.bytes.subarray(newline + 1);
        const waiting = this.waiting;
        this.waiting = undefined;
        waiting.resolve(value);
      }
      requireValue(this.bytes.length <= LIMIT);
    } catch {
      this.failed();
    }
  };
  receive(): Promise<unknown> {
    requireValue(!this.waiting && !this.failure && !this.abort.signal.aborted);
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject };
    });
  }
  async send(value: unknown): Promise<void> {
    requireValue(!this.failure && !this.abort.signal.aborted);
    const bytes = Buffer.from(JSON.stringify(value) + '\n');
    requireValue(bytes.length <= LIMIT);
    await new Promise<void>((resolve, reject) => {
      let completed = false;
      let writeError: Error | null | undefined;
      let notified = false;
      const settle = () => {
        // Abort only closes admission. It cannot settle the original write.
        // Node emits a write error AFTER its callback: retain the listener until
        // that actual error/close notification, too, rather than losing custody.
        if (!completed || (writeError && !notified && !this.output.closed)) return;
        this.output.off('error', notifiedFailure);
        this.output.off('close', notifiedFailure);
        if (writeError || this.failure || this.abort.signal.aborted)
          reject(this.failure ?? new Error('COVERAGE_OUTPUT_LOST'));
        else resolve();
      };
      const notifiedFailure = () => {
        notified = true;
        this.failed();
        settle();
      };
      this.output.on('error', notifiedFailure);
      this.output.on('close', notifiedFailure);
      try {
        this.output.write(bytes, (error) => {
          completed = true;
          writeError = error;
          settle();
        });
      } catch {
        completed = true;
        writeError = new Error('COVERAGE_OUTPUT_LOST');
        notifiedFailure();
      }
    });
  }

  dispose(): void {
    // Removing data listeners alone leaves process.stdin reading its owned pipe,
    // preventing the broker from observing remote exit while it holds stdin open.
    this.input.pause();
    this.input.off('data', this.data);
    this.input.off('end', this.failed);
    this.input.off('close', this.failed);
    this.input.off('error', this.failed);
    this.output.off('error', this.failed);
    this.abort.signal.removeEventListener('abort', this.failed);
  }
}

function opening(value: unknown): Opening {
  if (shape(value, ['kind', 'seq', 'podUid', 'request']) && value.kind === 'inventory') {
    requireValue(value.seq === 0 && isFileInventoryRequest(value.request));
    requireValue(
      typeof value.podUid === 'string' &&
        /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.podUid),
    );
    requireValue(
      process.env.POD_UID === value.podUid &&
        process.env.BUILD_COMMIT === value.request.source.sourceRevision,
    );
    return value as InventoryOpening;
  }
  requireValue(
    shape(value, ['kind', 'seq', 'podUid', 'run', 'action']) &&
      value.kind === 'open' &&
      value.seq === 0,
  );
  requireValue(
    isFileCoverageAction({ action: 'begin', run: value.run }) && isFileCoverageAction(value.action),
  );
  const run = value.run as FileCoverageRun;
  const action = value.action;
  requireValue(
    typeof value.podUid === 'string' &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.podUid),
  );
  if ('run' in action) requireValue(sameFileCoverageData(action.run, run));
  else if (action.action === 'inspect') {
    requireValue(
      action.storeId === run.storeId &&
        action.generation === run.generation &&
        action.runSha256 === fileCoverageDigest(run),
    );
  } else {
    requireValue(
      action.requestId === run.requestId &&
        action.storeId === run.storeId &&
        action.expectedGeneration === run.generation &&
        action.originalDeadline === run.originalDeadline,
    );
  }
  // These are existing downward/build values. Image/manifest/container identity is
  // independently pinned by the native broker; caller-provided env is not a grant.
  requireValue(
    process.env.POD_UID === value.podUid && process.env.BUILD_COMMIT === run.source.sourceRevision,
  );
  return value as Opening;
}

/** Exactly one closed data-owner action, original connection and actual close per exec.
 * Ordinary application/worker factories never import this finite admin subpath.
 * The native broker alone drives begin/advance/verify-seal, then a separate fixed
 * inspect under the SAME held invocation; no request/deadline is renewed here.
 */
export async function runFileCoverageAdmin(
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<number> {
  const abort = new AbortController();
  const channel = new Channel(input, output, abort);
  let timer = setTimeout(() => abort.abort(), 5_000);
  // A pending original close must not let an otherwise idle Node process exit0.
  const custody = setInterval(() => {}, 1_000);
  let mongoose: Mongoose | undefined;
  let closing: Promise<void> | undefined;
  let dispatched = false;
  let mutation = false;
  let seq = 0;
  let result: FileCoverageResult | FileInventoryResult = {
    outcome: 'refused',
    code: 'unavailable',
  };
  let request: Opening | undefined;
  let assertCurrent: ((phase: string, signal?: AbortSignal) => Promise<void>) | undefined;
  const ignore = () => {};
  function closeMongo(): Promise<void> {
    const connection = mongoose?.connection;
    if (!connection) return Promise.resolve();
    // Retain one original close promise, including synchronous/rejected closure.
    closing ??= Promise.resolve()
      .then(() => connection.close(true))
      .finally(() => {
        connection.off('error', ignore);
      });
    return closing;
  }
  try {
    try {
      request = opening(await channel.receive());
      const { podUid } = request;
      mutation = request.kind === 'open' && request.action.action !== 'inspect';
      const originalDeadline =
        request.kind === 'inventory'
          ? request.request.originalDeadline
          : request.run.originalDeadline;
      const deadline = Math.min(
        Date.now() + PROCESS_MS,
        mutation || request.kind === 'inventory'
          ? Date.parse(originalDeadline)
          : Date.now() + PROCESS_MS,
      );
      requireValue(deadline > Date.now() && !abort.signal.aborted);
      clearTimeout(timer);
      timer = setTimeout(() => abort.abort(), deadline - Date.now());
      const correlation =
        request.kind === 'inventory'
          ? { inventorySha256: fileCoverageDigest(request.request) }
          : {
              runSha256: fileCoverageDigest(request.run),
              actionSha256: fileCoverageDigest(request.action),
            };
      assertCurrent = async (phase, signal) => {
        requireValue(!abort.signal.aborted && !signal?.aborted && seq < 64);
        const waiting = channel.receive();
        void waiting.catch(ignore);
        await channel.send({ kind: 'assert', seq: ++seq, phase, ...correlation });
        const reply = await waiting;
        requireValue(
          shape(reply, ['kind', 'seq']) &&
            reply.kind === 'current' &&
            reply.seq === seq &&
            !abort.signal.aborted &&
            !signal?.aborted,
        );
      };
      const stat = readFileSync('/proc/self/stat', 'utf8')
        .split(') ')
        .slice(1)
        .join(') ')
        .split(' ');
      requireValue(/^\d+$/.test(stat[19]));
      await channel.send({
        kind: 'hello',
        seq,
        podUid,
        sourceRevision: process.env.BUILD_COMMIT,
        pid: process.pid,
        startTicks: stat[19],
        contract:
          request.kind === 'inventory'
            ? FILE_HOUSEKEEPING_INVENTORY_CONTRACT
            : FILE_HOUSEKEEPING_COVERAGE_CONTRACT,
        ...correlation,
      });
      await assertCurrent('before-open');
      const uri = process.env.MONGO_URI;
      requireValue(typeof uri === 'string' && uri.length > 0 && uri.length <= LIMIT);
      mongoose = new Mongoose();
      mongoose.set('strictQuery', true);
      mongoose.connection.on('error', ignore);
      const remaining = () => {
        requireValue(!abort.signal.aborted && deadline > Date.now());
        return Math.max(1, Math.min(2_000, deadline - Date.now()));
      };
      const bound = remaining();
      // Await the ORIGINAL opening promise even after abort. Driver timeouts bound
      // discovery; a timeout never substitutes for client/session settlement.
      await mongoose.connect(uri, {
        autoCreate: false,
        autoIndex: false,
        retryWrites: false,
        retryReads: false,
        maxPoolSize: 2,
        minPoolSize: 0,
        maxConnecting: 1,
        serverSelectionTimeoutMS: bound,
        connectTimeoutMS: bound,
        socketTimeoutMS: bound,
      });
      requireValue(mongoose.connection.db);
      const hello = await mongoose.connection.db.command(
        { hello: 1, maxTimeMS: remaining() },
        { timeoutMS: remaining(), signal: abort.signal },
      );
      const target = request.kind === 'inventory' ? request.request.target : request.run.native;
      requireValue(
        hello.setName === target.mongoReplicaSet &&
          mongoose.connection.name === target.mongoDatabase,
      );
      await assertCurrent('connected');
      if (request.kind === 'inventory') {
        await assertCurrent('before-action');
        dispatched = true;
        result = await inspectFileHousekeepingInventory(mongoose, request.request, abort.signal);
        await assertCurrent('owner');
      } else {
        const { run, action } = request;
        const owner = mongoose as unknown as typeof import('mongoose');
        createFileModel(owner);
        const store = createUploadStore(owner, {});
        const producer: FileCoverageNativeProducer = {
          async withCurrentQuiescence(_action, signal, callback) {
            try {
              await assertCurrent!('before-action', signal);
              return await callback(
                Object.freeze({
                  binding: Object.freeze({ ...run.native }),
                  source: Object.freeze({ ...run.source }),
                  assertCurrent: (currentSignal: AbortSignal) =>
                    assertCurrent!('owner', currentSignal),
                }),
              );
            } finally {
              // The native port itself retains original client closure, in addition
              // to the outer broker's continuous invocation/writer/timer exclusion.
              await closeMongo();
            }
          },
        };
        dispatched = true;
        result = await createFileHousekeepingCoverageMethods(store, producer).execute(
          action,
          abort.signal,
        );
      }
    } catch {
      result =
        dispatched && mutation
          ? { outcome: 'unknown', code: 'unknown_commit' }
          : { outcome: 'refused', code: 'unavailable' };
    } finally {
      if (mongoose) {
        try {
          // No Promise.race, abort response, kill or bounded-close surrogate.
          await closeMongo();
        } catch {
          result =
            dispatched && mutation
              ? { outcome: 'unknown', code: 'unknown_commit' }
              : { outcome: 'refused', code: 'unavailable' };
        }
      }
    }
    if (abort.signal.aborted) return 1; // Original close settled, but native transport is unknown.
    if (request && assertCurrent) await assertCurrent('closed');
    await channel.send({ kind: 'result', seq: ++seq, result });
    return result.outcome === 'unknown' || result.outcome === 'refused' ? 1 : 0;
  } catch {
    return 1; // Never reflect URI, Mongo errors, documents or original input.
  } finally {
    clearTimeout(timer);
    clearInterval(custody);
    channel.dispose();
  }
}
