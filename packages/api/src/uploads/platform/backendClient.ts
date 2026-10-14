/** Exact ConfigMap GET transport; native storage credentials never cross this boundary. */
import { request } from 'node:https';
import { readFile } from 'node:fs/promises';
import type { UploadBackendBinding, UploadBackendView, UploadDurability } from './backend';
import type { UploadClock } from '../control/types';
import {
  decodeUploadBackendView,
  selectUploadDurability,
  UPLOAD_SAFETY_NAMESPACE,
} from './backend';

export interface UploadSafetyTransportInput {
  name: string;
  token: string;
  ca: string | Buffer;
  signal: AbortSignal;
}
type Transport = (input: UploadSafetyTransportInput) => Promise<unknown>;
export interface UploadBackendClient {
  current(): UploadDurability;
  refresh(): Promise<void>;
  start(): Promise<void>;
  close(): Promise<void>;
}
export const fetchUploadSafetyConfigMap: Transport = ({ name, token, ca, signal }) =>
  new Promise((resolve, reject) => {
    const req = request(
      {
        protocol: 'https:',
        hostname: 'kubernetes.default.svc',
        port: 443,
        path: `/api/v1/namespaces/${UPLOAD_SAFETY_NAMESPACE}/configmaps/${encodeURIComponent(name)}`,
        method: 'GET',
        ca,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
        agent: false,
        signal,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          'accept-encoding': 'identity',
          connection: 'close',
        },
      },
      (res) => {
        if (
          res.statusCode !== 200 ||
          !/^application\/json(?:;|$)/i.test(res.headers['content-type'] ?? '') ||
          (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')
        ) {
          res.destroy();
          reject(new Error('unavailable_upload_safety'));
          return;
        }
        let bytes = 0;
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 64 * 1024) {
            res.destroy();
            req.destroy();
            reject(new Error('oversize_upload_safety'));
          } else chunks.push(chunk);
        });
        res.once('aborted', () => reject(new Error('incomplete_upload_safety')));
        res.once('error', () => reject(new Error('unavailable_upload_safety')));
        res.once('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')) as unknown);
          } catch {
            reject(new Error('invalid_upload_safety'));
          }
        });
      },
    );
    req.once('error', () => reject(new Error('unavailable_upload_safety')));
    req.end();
  });

export function createUploadBackendClient(options: {
  binding?: UploadBackendBinding;
  clock: () => UploadClock;
  ca: string | Buffer;
  readToken?: () => Promise<string>;
  transport?: Transport;
}): UploadBackendClient {
  let views: UploadBackendView[] = [];
  let flight: Promise<void> | undefined;
  let boundedFlight: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let controller: AbortController | undefined;
  let lastClock: UploadClock | undefined;
  let closed = false;
  function current(): UploadDurability {
    const now = options.clock();
    if (
      lastClock &&
      (now.nowMs < lastClock.nowMs ||
        now.monotonicMs < lastClock.monotonicMs ||
        Math.abs(now.nowMs - lastClock.nowMs - (now.monotonicMs - lastClock.monotonicMs)) > 1_000)
    )
      views = [];
    lastClock = { ...now };
    return selectUploadDurability(views, now);
  }
  function refresh(): Promise<void> {
    if (closed || !options.binding) return Promise.resolve();
    if (flight) return boundedFlight ?? Promise.resolve();
    const binding = options.binding;
    const start = options.clock();
    const ownedController = new AbortController();
    controller = ownedController;
    const signal = ownedController.signal;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timeout = setTimeout(() => {
        ownedController.abort();
        resolve();
      }, 3_000);
      timeout.unref();
    });
    flight = (async () => {
      const token = (
        await (
          options.readToken ??
          (() => readFile('/var/run/cortex-upload-safety/token', { encoding: 'utf8', signal }))
        )()
      ).trim();
      if (!/^[A-Za-z0-9_.-]{1,8192}$/.test(token) || signal.aborted)
        throw new Error('unavailable_upload_safety');
      const invalid = new Set<string>();
      const replies = await Promise.allSettled(
        binding.observers.map(async (observer) => {
          const raw = await (options.transport ?? fetchUploadSafetyConfigMap)({
            name: observer.name,
            ca: options.ca,
            token,
            signal,
          });
          const end = options.clock();
          if (
            signal.aborted ||
            end.monotonicMs - start.monotonicMs >= 3_000 ||
            end.monotonicMs < start.monotonicMs ||
            Math.abs(end.nowMs - start.nowMs - (end.monotonicMs - start.monotonicMs)) > 1_000
          )
            throw new Error('expired_upload_safety');
          try {
            return decodeUploadBackendView(
              raw,
              binding,
              observer,
              end,
              views.find((view) => view.observer === observer.observer),
            );
          } catch (error) {
            invalid.add(observer.observer);
            throw error;
          }
        }),
      );
      if (closed) return;
      const fresh = replies.flatMap((reply) => (reply.status === 'fulfilled' ? [reply.value] : []));
      views = [
        ...fresh,
        ...views.filter(
          (view) =>
            !invalid.has(view.observer) && !fresh.some((next) => next.observer === view.observer),
        ),
      ];
      current();
    })()
      .catch(() => {
        current();
      })
      .finally(() => {
        flight = undefined;
        controller = undefined;
      });
    // An uncancellable filesystem read can outlive the deadline, but owns the sole in-flight slot.
    boundedFlight = Promise.race([flight, deadline]).finally(() => clearTimeout(timeout));
    return boundedFlight;
  }
  return {
    current,
    refresh,
    async start(): Promise<void> {
      if (closed || timer) return;
      await refresh();
      if (!closed && !timer) {
        timer = setInterval(() => {
          void refresh();
        }, 10_000);
        timer.unref();
      }
    },
    async close(): Promise<void> {
      closed = true;
      clearInterval(timer);
      controller?.abort();
      await boundedFlight;
      views = [];
    },
  };
}
