/** Source-bound collector evidence never becomes fresh or joined from scrape time or timeout. */
import type { UploadNfsReportClientOptions } from './nfsReports';
import { createUploadNfsReportClient, decodeUploadNfsReports } from './nfsReports';

const NOW = 1793394000000;
const hosts = [2, 3, 4, 5].map((n) => `lx-s-bwi-cpu-${n}`);
const backend = {
  kind: 'nas-s3' as const,
  uid: 'private-nas',
  protocol: 'acknowledged-only-v1' as const,
  configurationSha256: 'a'.repeat(64),
};
const configuration = 'b'.repeat(64),
  source = 'c'.repeat(64),
  cohort = 'd'.repeat(64);
const options = (): UploadNfsReportClientOptions => ({
  collectors: [
    { observer: 'observer-2', url: 'https://observer-2.test:9446/v1/upload-resources' },
    { observer: 'observer-3', url: 'https://observer-3.test:9446/v1/upload-resources' },
  ],
  tls: { ca: 'synthetic-ca', cert: 'synthetic-cert', key: 'synthetic-key' },
  binding: {
    backend,
    cpuHosts: hosts,
    cohortSha256: cohort,
    nfsSourceSha256: source,
    intervalMs: 60000,
    maxAgeMs: 90000,
  },
  expectedReports: hosts.map((hostId) => ({
    hostId,
    configurationSha256: configuration,
    backendBindingSha256: backend.configurationSha256,
  })),
  clock: () => ({ nowMs: NOW, monotonicMs: 1000 }),
});
const report = (hostId: string) => ({
  schema: 1,
  hostId,
  bootId: '10000000-0000-4000-8000-000000000001',
  invocationId: '1'.repeat(32),
  configurationSha256: configuration,
  backendBindingSha256: backend.configurationSha256,
  producerSha256: source,
  startedAtEpoch: (NOW - 2000) / 1000,
  expiresAtEpoch: (NOW + 88000) / 1000,
  observedAt: new Date(NOW - 1000).toISOString(),
  actor: {
    host: hostId,
    bootId: '10000000-0000-4000-8000-000000000001',
    pid: 1234,
    startTicks: 5678,
    invocationId: '1'.repeat(32),
    producerSha256: source,
  },
  phase: 'complete',
  nfs: { state: 'ready', cause: 'none' },
  s3: { state: 'not-observed' },
  uploadAdmissionAccepted: false,
  mountIdentitySha256: 'e'.repeat(64),
  writeReadSha256: 'f'.repeat(64),
  joined: true,
  pending: false,
});
function vector(observer = 'observer-2', change?: (value: ReturnType<typeof report>) => void) {
  return {
    status: 'success',
    data: {
      resultType: 'vector',
      result: hosts.map((node) => {
        const value = report(node);
        change?.(value);
        return {
          metric: {
            __name__: 'cortex_upload_nfs_report',
            observer,
            node,
            hostId: value.hostId,
            configurationSha256: configuration,
            backendBindingSha256: backend.configurationSha256,
            report: Buffer.from(JSON.stringify(value)).toString('base64'),
          },
          value: [NOW / 1000, '1'],
        };
      }),
    },
  };
}
const context = (signal = new AbortController().signal) => ({
  signal,
  startedAtMs: NOW,
  deadlineAtMs: NOW + 15000,
  maxAgeMs: 90000,
});

describe('authentic source-bound NFS report decoding', () => {
  it('retains all four source clocks, binding and joined identity without scrape-time restamping', () => {
    const proofs = decodeUploadNfsReports(vector(), 'observer-2', options(), NOW);
    expect(proofs).toHaveLength(4);
    expect(proofs[0]).toMatchObject({
      hostId: hosts[0],
      backend,
      sourceSha256: source,
      cohortSha256: cohort,
      startedAtMs: NOW - 2000,
      completedAtMs: NOW - 1000,
      expiresAtMs: NOW + 88000,
      originalState: 'joined',
      outcome: 'ready',
    });
  });
  it.each([
    'joined',
    'pending',
    'source',
    'backend',
    'config',
    'expired',
    'future',
    'actor',
    'hash',
  ])('refuses invalid original report %s regardless of a fresh Prometheus result', (caseName) => {
    const body = vector('observer-2', (value) => {
      if (caseName === 'joined') value.joined = false;
      if (caseName === 'pending') value.pending = true;
      if (caseName === 'source') value.producerSha256 = '0'.repeat(64);
      if (caseName === 'backend') value.backendBindingSha256 = '0'.repeat(64);
      if (caseName === 'config') value.configurationSha256 = '0'.repeat(64);
      if (caseName === 'expired') {
        value.startedAtEpoch -= 100;
        value.expiresAtEpoch -= 100;
      }
      if (caseName === 'future') value.startedAtEpoch += 100;
      if (caseName === 'actor') value.actor.startTicks = 0;
      if (caseName === 'hash') value.writeReadSha256 = '';
    });
    expect(() => decodeUploadNfsReports(body, 'observer-2', options(), NOW)).toThrow();
  });
  it('rejects missing, duplicate, extra, foreign observer and unknown metric values', () => {
    for (const mutate of [
      (v: ReturnType<typeof vector>) => {
        v.data.result.pop();
      },
      (v: ReturnType<typeof vector>) => {
        v.data.result[1] = v.data.result[0];
      },
      (v: ReturnType<typeof vector>) => {
        v.data.result.push(v.data.result[0]);
      },
      (v: ReturnType<typeof vector>) => {
        v.data.result[0].metric.observer = 'other';
      },
      (v: ReturnType<typeof vector>) => {
        v.data.result[0].value[1] = '0';
      },
    ]) {
      const body = vector();
      mutate(body);
      expect(() => decodeUploadNfsReports(body, 'observer-2', options(), NOW)).toThrow();
    }
  });
  it('rejects malformed encoded JSON and an excessively renewed source expiry', () => {
    const body = vector();
    body.data.result[0].metric.report = '!!!!';
    expect(() => decodeUploadNfsReports(body, 'observer-2', options(), NOW)).toThrow();
    expect(() =>
      decodeUploadNfsReports(
        vector('observer-2', (v) => {
          v.expiresAtEpoch += 1000;
        }),
        'observer-2',
        options(),
        NOW,
      ),
    ).toThrow();
  });
});

describe('one original authenticated collector flight', () => {
  it('reads both fixed paths with cloned TLS and preserves namespace binding', async () => {
    const opts = options();
    const calls: string[] = [];
    const owner = createUploadNfsReportClient(opts, async (url, tls, _signal, budget) => {
      calls.push(url.href);
      expect(tls.key).not.toBe(opts.tls.key);
      budget(100);
      return vector(url.hostname.startsWith('observer-2') ? 'observer-2' : 'observer-3');
    });
    try {
      expect(await owner.readNfs(context())).toHaveLength(4);
      expect(calls).toEqual([
        'https://observer-2.test:9446/v1/upload-nfs-reports',
        'https://observer-3.test:9446/v1/upload-nfs-reports',
      ]);
    } finally {
      await owner.close();
    }
  });
  it('does not discard one collector unknown for another green', async () => {
    const owner = createUploadNfsReportClient(options(), async (url) =>
      vector(url.hostname.startsWith('observer-2') ? 'observer-2' : 'observer-3', (v) => {
        if (url.hostname.startsWith('observer-3')) v.joined = false;
      }),
    );
    try {
      await expect(owner.readNfs(context())).rejects.toThrow('nfs_report_unavailable');
    } finally {
      await owner.close();
    }
  });
  it('abort does not join an unresolved original or permit another flight', async () => {
    const releases: Array<() => void> = [];
    let calls = 0;
    const controller = new AbortController();
    const owner = createUploadNfsReportClient(options(), async (url) => {
      calls++;
      await new Promise<void>((resolve) => {
        releases.push(resolve);
      });
      return vector(url.hostname.startsWith('observer-2') ? 'observer-2' : 'observer-3');
    });
    const flight = owner.readNfs(context(controller.signal));
    controller.abort();
    expect(owner.readNfs(context())).toBe(flight);
    expect(calls).toBe(2);
    let closed = false;
    const close = owner.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    releases.forEach((release) => release());
    await expect(flight).rejects.toThrow();
    await close;
    await expect(owner.readNfs(context())).rejects.toThrow();
    expect(calls).toBe(2);
  });
  it('rejects malformed policy and pre-aborted or expired contexts before dispatch', async () => {
    const bad = options();
    bad.expectedReports[0].backendBindingSha256 = '0'.repeat(64);
    expect(() => createUploadNfsReportClient(bad)).toThrow();
    const transport = jest.fn();
    const owner = createUploadNfsReportClient(options(), transport);
    const aborted = new AbortController();
    aborted.abort();
    await expect(owner.readNfs(context(aborted.signal))).rejects.toThrow();
    await expect(owner.readNfs({ ...context(), deadlineAtMs: NOW })).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
    await owner.close();
  });
  it('bounds aggregate responses and rejects changed monotonic clocks', async () => {
    const owner = createUploadNfsReportClient(options(), async (url, _tls, _signal, budget) => {
      budget(128 * 1024);
      return vector(url.hostname.startsWith('observer-2') ? 'observer-2' : 'observer-3');
    });
    try {
      await expect(owner.readNfs(context())).rejects.toThrow();
    } finally {
      await owner.close();
    }
  });
});
