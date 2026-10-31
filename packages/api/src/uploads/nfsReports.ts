/** nfsReports reads only bound original NFS reports over the existing authenticated collector. */
import { request } from 'node:https';
import { performance } from 'node:perf_hooks';
import { readUploadStorageHealthBinding, readUploadNfsWriteProof } from 'librechat-data-provider';
import type { UploadStorageHealthBinding, UploadNfsWriteProof } from 'librechat-data-provider';
import type { NasS3HealthContext } from '../storage/nas/health';

/** Nonsecret normal collector policy; native delivery must authenticate actual source/config first. */
export interface UploadNfsReportClientOptions {
  collectors: readonly { observer: string; url: string }[];
  tls: { ca: string | Buffer; cert: string | Buffer; key: string | Buffer };
  binding: UploadStorageHealthBinding;
  expectedReports: readonly {
    hostId: string;
    configurationSha256: string;
    backendBindingSha256: string;
  }[];
  clock?: () => { nowMs: number; monotonicMs: number };
}
type Transport = (
  url: URL,
  tls: UploadNfsReportClientOptions['tls'],
  signal: AbortSignal,
  budget: (n: number) => void,
) => Promise<unknown>;
const fail = (): never => {
  throw new Error('nfs_report_unavailable');
};
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const record = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return fail();
  const p = Object.getPrototypeOf(v);
  if (p !== Object.prototype && p !== null) return fail();
  const r: Record<string, unknown> = Object.create(null);
  for (const k of Reflect.ownKeys(v)) {
    if (typeof k !== 'string') return fail();
    const d = Object.getOwnPropertyDescriptor(v, k);
    if (!d?.enumerable || !('value' in d)) return fail();
    r[k] = d.value;
  }
  return r;
};
const epoch = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v * 1000) : fail();

/** Prometheus evaluation time never grants freshness; each source's original clock is retained. */
export function decodeUploadNfsReports(
  body: unknown,
  observer: string,
  options: UploadNfsReportClientOptions,
  now: number,
): UploadNfsWriteProof[] {
  const root = record(body),
    data = record(root.data);
  if (
    root.status !== 'success' ||
    root.warnings !== undefined ||
    root.infos !== undefined ||
    data.resultType !== 'vector' ||
    !Array.isArray(data.result) ||
    data.result.length !== 4
  )
    return fail();
  const expected = new Map(options.expectedReports.map((r) => [r.hostId, r]));
  const seen = new Set<string>();
  const proofs: UploadNfsWriteProof[] = [];
  for (const raw of data.result) {
    const row = record(raw),
      m = record(row.metric);
    if (
      m.__name__ !== 'cortex_upload_nfs_report' ||
      m.observer !== observer ||
      typeof m.node !== 'string' ||
      !expected.has(m.node) ||
      seen.has(m.node) ||
      !Array.isArray(row.value) ||
      row.value.length !== 2 ||
      Number(row.value[1]) !== 1 ||
      typeof m.report !== 'string' ||
      m.report.length > 16384 ||
      !/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(m.report)
    )
      return fail();
    if (
      Object.keys(m).some(
        (k) =>
          ![
            '__name__',
            'observer',
            'node',
            'hostId',
            'configurationSha256',
            'backendBindingSha256',
            'report',
          ].includes(k),
      )
    )
      return fail();
    const e = expected.get(m.node)!;
    seen.add(m.node);
    const bytes = Buffer.from(m.report, 'base64');
    if (bytes.toString('base64') !== m.report) return fail();
    const v = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))),
      actor = record(v.actor),
      nfs = record(v.nfs),
      s3 = record(v.s3);
    if (
      !/^lx-s-bwi-cpu-[2-5]$/.test(m.node) ||
      v.schema !== 1 ||
      v.hostId !== m.node ||
      m.hostId !== m.node ||
      actor.host !== m.node ||
      m.configurationSha256 !== e.configurationSha256 ||
      v.configurationSha256 !== e.configurationSha256 ||
      m.backendBindingSha256 !== e.backendBindingSha256 ||
      v.backendBindingSha256 !== e.backendBindingSha256 ||
      v.producerSha256 !== options.binding.nfsSourceSha256 ||
      actor.producerSha256 !== v.producerSha256 ||
      typeof v.bootId !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(v.bootId) ||
      actor.bootId !== v.bootId ||
      typeof v.invocationId !== 'string' ||
      !/^[a-f0-9]{32}$/.test(v.invocationId) ||
      actor.invocationId !== v.invocationId ||
      !Number.isSafeInteger(actor.pid) ||
      Number(actor.pid) <= 0 ||
      !Number.isSafeInteger(actor.startTicks) ||
      Number(actor.startTicks) <= 0 ||
      v.joined !== true ||
      v.pending !== false ||
      v.phase !== 'complete' ||
      nfs.state !== 'ready' ||
      nfs.cause !== 'none' ||
      s3.state !== 'not-observed' ||
      v.uploadAdmissionAccepted !== false ||
      !hash(v.mountIdentitySha256) ||
      !hash(v.writeReadSha256)
    )
      return fail();
    const startedAtMs = epoch(v.startedAtEpoch),
      expiresAtMs = Math.min(epoch(v.expiresAtEpoch), startedAtMs + 90000);
    const completedAtMs = typeof v.observedAt === 'string' ? Date.parse(v.observedAt) : NaN;
    if (
      epoch(v.expiresAtEpoch) - startedAtMs > 90001 ||
      expiresAtMs <= now ||
      startedAtMs > now ||
      completedAtMs > now
    )
      return fail();
    const proof = readUploadNfsWriteProof({
      version: 1,
      hostId: m.node,
      backend: options.binding.backend,
      cohortSha256: options.binding.cohortSha256,
      sourceSha256: v.producerSha256,
      probeId: v.invocationId,
      mountIdentitySha256: v.mountIdentitySha256,
      writeReadSha256: v.writeReadSha256,
      originalState: 'joined',
      outcome: 'ready',
      startedAtMs,
      completedAtMs,
      expiresAtMs,
    });
    if (!proof) return fail();
    proofs.push(proof);
  }
  return proofs;
}

/** Fixed GET with strict existing mTLS, bounded body and completion only after its request closes. */
const fetchReports: Transport = (url, tls, signal, budget) =>
  new Promise((resolve, reject) => {
    let value: unknown,
      error: Error | undefined,
      complete = false;
    const req = request(
      url,
      {
        ...tls,
        method: 'GET',
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
          error = new Error('nfs_report_unavailable');
          res.destroy();
          req.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          try {
            budget(chunk.length);
            chunks.push(chunk);
          } catch {
            error = new Error('nfs_report_unavailable');
            req.destroy();
          }
        });
        res.on('error', () => {
          error = new Error('nfs_report_unavailable');
          req.destroy();
        });
        res.on('aborted', () => {
          error = new Error('nfs_report_unavailable');
          req.destroy();
        });
        res.on('end', () => {
          try {
            value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            complete = true;
          } catch {
            error = new Error('nfs_report_unavailable');
          }
        });
      },
    );
    req.on('error', () => {
      error = new Error('nfs_report_unavailable');
    });
    req.on('close', () => {
      if (error || !complete) reject(error ?? new Error('nfs_report_unavailable'));
      else resolve(value);
    });
    req.end();
  });

/** One original transport flight stays owned until actual settlement, including shutdown. */
export interface UploadNfsReportClient {
  readNfs(context: NasS3HealthContext): Promise<readonly UploadNfsWriteProof[]>;
  close(): Promise<void>;
}

/** No scheduler, new credential lookup or authority from caller-supplied availability booleans. */
export function createUploadNfsReportClient(
  supplied: UploadNfsReportClientOptions,
  transport: Transport = fetchReports,
): UploadNfsReportClient {
  const binding = readUploadStorageHealthBinding(supplied.binding);
  if (!binding) return fail();
  const expectedReports = supplied.expectedReports.map((r) => ({ ...r }));
  if (
    expectedReports.length !== 4 ||
    new Set(expectedReports.map((r) => r.hostId)).size !== 4 ||
    expectedReports.some(
      (r) =>
        !binding.cpuHosts.includes(r.hostId) ||
        !/^lx-s-bwi-cpu-[2-5]$/.test(r.hostId) ||
        !hash(r.configurationSha256) ||
        !hash(r.backendBindingSha256) ||
        r.backendBindingSha256 !== binding.backend.configurationSha256,
    ) ||
    supplied.collectors.length !== 2 ||
    !supplied.tls.ca.length ||
    !supplied.tls.cert.length ||
    !supplied.tls.key.length
  )
    return fail();
  const collectors = supplied.collectors.map((c) => {
    const url = new URL(c.url);
    if (
      url.protocol !== 'https:' ||
      !['/v1/upload-resources', '/v1/upload-nfs-reports'].includes(url.pathname) ||
      url.search ||
      url.hash ||
      url.username ||
      url.password ||
      !/^[-A-Za-z0-9_.]{1,80}$/.test(c.observer)
    )
      return fail();
    url.pathname = '/v1/upload-nfs-reports';
    return { observer: c.observer, url };
  });
  if (
    new Set(collectors.map((c) => c.url.origin)).size !== 2 ||
    new Set(collectors.map((c) => c.observer)).size !== 2
  )
    return fail();
  const tls = {
    ca: Buffer.from(supplied.tls.ca),
    cert: Buffer.from(supplied.tls.cert),
    key: Buffer.from(supplied.tls.key),
  };
  const options = { ...supplied, binding, expectedReports, tls };
  const clock = supplied.clock ?? (() => ({ nowMs: Date.now(), monotonicMs: performance.now() }));
  let flight: Promise<readonly UploadNfsWriteProof[]> | undefined,
    abort: AbortController | undefined,
    closed = false;
  function readNfs(context: NasS3HealthContext): Promise<readonly UploadNfsWriteProof[]> {
    if (closed || context.signal.aborted)
      return Promise.reject(new Error('nfs_report_unavailable'));
    if (flight) return flight;
    if (
      !Number.isSafeInteger(context.startedAtMs) ||
      !Number.isSafeInteger(context.deadlineAtMs) ||
      context.startedAtMs < 0 ||
      context.deadlineAtMs <= context.startedAtMs ||
      context.deadlineAtMs - context.startedAtMs > 20000 ||
      context.maxAgeMs !== 90000
    )
      return Promise.reject(new Error('nfs_report_unavailable'));
    const at = clock();
    if (
      at.nowMs < context.startedAtMs ||
      at.nowMs >= context.deadlineAtMs ||
      !Number.isSafeInteger(at.nowMs) ||
      !Number.isFinite(at.monotonicMs)
    )
      return Promise.reject(new Error('nfs_report_unavailable'));
    abort = new AbortController();
    const controller = abort;
    const cancel = () => controller.abort();
    context.signal.addEventListener('abort', cancel, { once: true });
    if (context.signal.aborted) cancel();
    const end = Math.min(context.deadlineAtMs, at.nowMs + 3000);
    const timer = setTimeout(cancel, Math.max(0, end - at.nowMs));
    timer.unref?.();
    let remaining = 128 * 1024;
    const budget = (n: number) => {
      remaining -= n;
      if (!Number.isSafeInteger(n) || n < 0 || remaining < 0) {
        cancel();
        fail();
      }
    };
    flight = (async () => {
      const results = await Promise.allSettled(
        collectors.map(async (c) => {
          const body = await transport(c.url, tls, controller.signal, budget);
          const now = clock();
          if (
            controller.signal.aborted ||
            now.nowMs >= end ||
            now.nowMs < at.nowMs ||
            now.monotonicMs < at.monotonicMs ||
            Math.abs(now.nowMs - at.nowMs - (now.monotonicMs - at.monotonicMs)) > 1000
          )
            return fail();
          return decodeUploadNfsReports(body, c.observer, options, now.nowMs);
        }),
      );
      if (results.some((r) => r.status !== 'fulfilled')) return fail();
      const a = (results[0] as PromiseFulfilledResult<UploadNfsWriteProof[]>).value;
      const b = (results[1] as PromiseFulfilledResult<UploadNfsWriteProof[]>).value;
      // A concurrent unknown/changed report cannot be discarded for another collector's green.
      return a.map((x) => {
        const y = b.find((r) => r.hostId === x.hostId)!;
        if (x.startedAtMs === y.startedAtMs && JSON.stringify(x) !== JSON.stringify(y))
          return fail();
        return y.startedAtMs > x.startedAtMs ? y : x;
      });
    })().finally(() => {
      clearTimeout(timer);
      context.signal.removeEventListener('abort', cancel);
      abort = undefined;
      flight = undefined;
    });
    return flight;
  }
  return {
    readNfs,
    async close(): Promise<void> {
      closed = true;
      abort?.abort();
      await flight?.catch(() => undefined);
      tls.ca.fill(0);
      tls.cert.fill(0);
      tls.key.fill(0);
    },
  };
}
