import { request } from 'node:https';
import type { UploadClock, UploadResourceKey, UploadResourceSnapshot } from './types';
import { decodeUploadProjection } from './projection';
export interface UploadSnapshotOptions {
  collectors: readonly { observer: string; url: string }[];
  expected: readonly UploadResourceKey[];
  tls: { ca: string | Buffer; cert: string | Buffer; key: string | Buffer };
  clock: () => UploadClock;
  observeRefresh?: (input: {
    outcome: 'ok' | 'partial' | 'failed';
    durationSeconds: number;
  }) => void;
}
type Transport = (
  url: URL,
  options: UploadSnapshotOptions['tls'],
  signal: AbortSignal,
  consumeBytes: (count: number) => void,
) => Promise<unknown>;
/** One fixed GET, verified TLS, no redirects, compression, proxy environment or credentials lookup. */
const fetchProjection: Transport = (url, tls, signal, consumeBytes) =>
  new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'GET',
        ...tls,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
        agent: false,
        signal,
        headers: { Accept: 'application/json', 'Accept-Encoding': 'identity', Connection: 'close' },
      },
      (res) => {
        if (
          res.statusCode !== 200 ||
          !/^application\/json(?:;|$)/i.test(res.headers['content-type'] ?? '') ||
          (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')
        ) {
          res.destroy();
          reject(new Error('invalid_upload_response'));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          try {
            consumeBytes(chunk.length);
            chunks.push(chunk);
          } catch {
            res.destroy();
            reject(new Error('oversize_upload_response'));
          }
        });
        res.on('error', () => reject(new Error('failed_upload_response')));
        res.on('aborted', () => reject(new Error('incomplete_upload_response')));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
          } catch {
            reject(new Error('invalid_upload_json'));
          }
        });
      },
    );
    req.on('error', () => reject(new Error('failed_upload_request')));
    req.end();
  });

/** Explicit refresh only. The fenced global controller owns scheduling, never a request handler. */
export function createUploadSnapshotClient(
  options: UploadSnapshotOptions,
  transport: Transport = fetchProjection,
): { refresh(): Promise<void>; current(): UploadResourceSnapshot[] } {
  if (
    options.collectors.length !== 2 ||
    new Set(options.collectors.map((collector) => collector.observer)).size !== 2 ||
    !options.expected.length ||
    options.expected.length > 64 ||
    !options.tls.ca.length ||
    !options.tls.cert.length ||
    !options.tls.key.length
  )
    throw new Error('invalid_upload_collectors');
  const collectors = options.collectors.map((collector) => {
    const url = new URL(collector.url);
    if (
      url.protocol !== 'https:' ||
      url.pathname !== '/v1/upload-resources' ||
      url.search ||
      url.hash ||
      url.username ||
      url.password ||
      !/^[a-zA-Z0-9_.-]{1,80}$/.test(collector.observer)
    )
      throw new Error('invalid_upload_endpoint');
    return { ...collector, url };
  });
  if (new Set(collectors.map((collector) => collector.url.origin)).size !== 2)
    throw new Error('duplicate_upload_endpoint');
  let snapshots: UploadResourceSnapshot[] = [];
  let lastAttempt = -Infinity;
  let lastClock: UploadClock | undefined;
  let flight: Promise<void> | undefined;
  function current(): UploadResourceSnapshot[] {
    const clock = options.clock();
    if (
      ![clock.nowMs, clock.monotonicMs].every(Number.isFinite) ||
      (lastClock &&
        (clock.nowMs < lastClock.nowMs ||
          clock.monotonicMs < lastClock.monotonicMs ||
          Math.abs(clock.nowMs - lastClock.nowMs - (clock.monotonicMs - lastClock.monotonicMs)) >
            5000))
    )
      return [];
    return snapshots
      .filter(
        (snapshot) =>
          snapshot.expiresAtMs > clock.nowMs && snapshot.expiresMonotonicMs > clock.monotonicMs,
      )
      .map((snapshot) => ({
        ...snapshot,
        receivedAt: { ...snapshot.receivedAt },
        samples: snapshot.samples.map((sample) => ({ ...sample })),
      }));
  }
  function refresh(): Promise<void> {
    if (flight) return flight;
    const start = options.clock();
    if (
      ![start.nowMs, start.monotonicMs].every(Number.isFinite) ||
      start.monotonicMs - lastAttempt < 30000
    )
      return Promise.resolve();
    lastAttempt = start.monotonicMs;
    flight = (async () => {
      const abort = new AbortController();
      const timeout = setTimeout(() => abort.abort(), 3000);
      let remaining = 256 * 1024;
      const consumeBytes = (count: number) => {
        remaining -= count;
        if (!Number.isSafeInteger(count) || count < 0 || remaining < 0) {
          abort.abort();
          throw new Error('oversize_upload_response');
        }
      };
      try {
        const results = await Promise.allSettled(
          collectors.map(async (collector) => {
            const body = await transport(collector.url, options.tls, abort.signal, consumeBytes);
            const received = options.clock();
            if (
              abort.signal.aborted ||
              received.monotonicMs < start.monotonicMs ||
              received.monotonicMs - start.monotonicMs > 3000 ||
              Math.abs(received.nowMs - start.nowMs - (received.monotonicMs - start.monotonicMs)) >
                5000
            )
              throw new Error('invalid_upload_refresh_clock');
            return decodeUploadProjection(body, collector.observer, options.expected, received);
          }),
        );
        const fresh = results.flatMap((result) =>
          result.status === 'fulfilled' ? [result.value] : [],
        );
        // An outage retains original source deadlines; successful peers replace only their own view.
        snapshots = [
          ...fresh,
          ...snapshots.filter(
            (snapshot) => !fresh.some((updated) => updated.observer === snapshot.observer),
          ),
        ];
        const end = options.clock();
        lastClock = { ...end };
        let outcome: 'ok' | 'partial' | 'failed' = 'failed';
        if (fresh.length === 2) outcome = 'ok';
        else if (fresh.length === 1) outcome = 'partial';
        options.observeRefresh?.({
          outcome,
          durationSeconds: Math.max(0, (end.monotonicMs - start.monotonicMs) / 1000),
        });
      } finally {
        clearTimeout(timeout);
      }
    })().finally(() => {
      flight = undefined;
    });
    return flight;
  }
  return { refresh, current };
}
