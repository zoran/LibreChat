import { request } from 'node:https';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { UploadSafetyTransportInput } from './backendClient';
import {
  decodeUploadBackendView,
  parseUploadBackendBinding,
  selectUploadDurability,
  UPLOAD_BACKEND_FREE_BYTES,
} from './backend';
import { createUploadBackendClient, fetchUploadSafetyConfigMap } from './backendClient';

jest.mock('node:https', () => ({ request: jest.fn() }));

const at = 1800000000000;
const hosts = [1, 2, 3, 4].map((number) => `lx-s-bwi-cpu-${number}`);
const binding = parseUploadBackendBinding(
  {
    schema: 1,
    deploymentId: 'deployment',
    storeId: 'store',
    bucket: 'cortex-managed-uploads',
    collection: 'cortex-managed-uploads',
    observers: [
      { observer: 'cpu-2', name: 'cortex-upload-safety-cpu-2', uid: 'observer-2' },
      { observer: 'cpu-4', name: 'cortex-upload-safety-cpu-4', uid: 'observer-4' },
    ],
    policy: {
      revision: 'qualified-revision',
      sourceSha256: 'a'.repeat(64),
      filers: [
        { member: 'filer-1', podUid: 'filer-pod-1', processId: 'containerd://filer-1' },
        { member: 'filer-4', podUid: 'filer-pod-4', processId: 'containerd://filer-4' },
      ],
    },
    filesystems: hosts.map((hostId) => ({
      hostId,
      pvUid: `${hostId}-pv`,
      filesystemId: `${hostId}-fs`,
    })),
  },
  hosts,
);

function configMap(index = 0, change: Record<string, unknown> = {}) {
  const observer = binding.observers[index];
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: observer.name, namespace: 'cortex-objectstore', uid: observer.uid },
    data: {
      'snapshot.json': JSON.stringify({
        schema: 1,
        observer: observer.observer,
        deploymentId: binding.deploymentId,
        storeId: binding.storeId,
        bucket: binding.bucket,
        collection: binding.collection,
        collectedFromMs: at,
        collectedThroughMs: at + 1000,
        publishedAtMs: at + 1100,
        state: 'safe',
        reason: 'qualified',
        policy: binding.policy,
        filesystems: binding.filesystems.map((disk) => ({
          ...disk,
          freeBytes: UPLOAD_BACKEND_FREE_BYTES,
        })),
        volumes: [
          { id: 7, collection: binding.collection, replication: '020', hosts: hosts.slice(0, 3) },
        ],
        ...change,
      }),
    },
  };
}
const clock = { nowMs: at + 2000, monotonicMs: 2000 };

describe('independent backend safety evidence', () => {
  it('requires three distinct physical hosts for each individual volume', () => {
    expect(decodeUploadBackendView(configMap(), binding, binding.observers[0], clock).state).toBe(
      'safe',
    );
    const raw = configMap(0, {
      volumes: [
        {
          id: 7,
          collection: binding.collection,
          replication: '020',
          hosts: [hosts[0], hosts[0], hosts[1]],
        },
      ],
    });
    expect(decodeUploadBackendView(raw, binding, binding.observers[0], clock).state).toBe(
      'unknown',
    );
  });
  it('rejects a replaced publisher and makes policy/process or filesystem drift unknown', () => {
    const replaced = configMap();
    replaced.metadata.uid = 'replacement';
    expect(() => decodeUploadBackendView(replaced, binding, binding.observers[0], clock)).toThrow();
    const policy = {
      ...binding.policy,
      filers: binding.policy.filers.map((filer) => ({ ...filer, processId: 'restarted' })),
    };
    expect(
      decodeUploadBackendView(configMap(0, { policy }), binding, binding.observers[0], clock).state,
    ).toBe('unknown');
    const filesystems = binding.filesystems.map((disk, index) => ({
      ...disk,
      freeBytes: UPLOAD_BACKEND_FREE_BYTES - (index === 3 ? 1 : 0),
    }));
    expect(
      decodeUploadBackendView(configMap(0, { filesystems }), binding, binding.observers[0], clock)
        .state,
    ).toBe('unknown');
  });
  it('never infers that a vanished collection is a newly empty bucket', () => {
    expect(
      decodeUploadBackendView(configMap(0, { volumes: [] }), binding, binding.observers[0], clock)
        .state,
    ).toBe('unknown');
  });
  it('expires from collection start and does not renew duplicate evidence', () => {
    const first = decodeUploadBackendView(configMap(), binding, binding.observers[0], clock);
    expect(() =>
      decodeUploadBackendView(configMap(), binding, binding.observers[0], {
        nowMs: at + 70000,
        monotonicMs: 70000,
      }),
    ).toThrow();
    const duplicate = decodeUploadBackendView(
      configMap(0, { publishedAtMs: at + 1500 }),
      binding,
      binding.observers[0],
      { nowMs: at + 2000, monotonicMs: 5000 },
      first,
    );
    expect(duplicate.expiresMonotonicMs).toBe(first.expiresMonotonicMs);
    expect(() =>
      decodeUploadBackendView(
        configMap(0, { publishedAtMs: at + 2001 }),
        binding,
        binding.observers[0],
        clock,
      ),
    ).toThrow();
  });
  it('uses a complete live peer, while an explicit fresh unknown vetoes until a newer safe collection', () => {
    const safe = decodeUploadBackendView(configMap(), binding, binding.observers[0], clock);
    expect(selectUploadDurability([safe], clock).state).toBe('safe');
    const unknown = decodeUploadBackendView(
      configMap(1, { state: 'unknown', reason: 'timeout' }),
      binding,
      binding.observers[1],
      clock,
    );
    expect(selectUploadDurability([safe, unknown], clock).state).toBe('unknown');
    const laterClock = { nowMs: at + 32000, monotonicMs: 32000 };
    const later = decodeUploadBackendView(
      configMap(0, {
        collectedFromMs: at + 30000,
        collectedThroughMs: at + 31000,
        publishedAtMs: at + 31100,
      }),
      binding,
      binding.observers[0],
      laterClock,
    );
    expect(selectUploadDurability([later, unknown], laterClock).state).toBe('safe');
  });
  it('reads a rotated projected token and retains no fabricated safety without a binding', async () => {
    const readToken = jest
      .fn()
      .mockResolvedValueOnce('first.token')
      .mockResolvedValueOnce('second.token');
    const transport = jest.fn(async ({ name }: UploadSafetyTransportInput) =>
      configMap(name.endsWith('cpu-2') ? 0 : 1),
    );
    const client = createUploadBackendClient({
      binding,
      ca: 'ca',
      clock: () => clock,
      readToken,
      transport,
    });
    await client.refresh();
    await client.refresh();
    expect(client.current().state).toBe('safe');
    expect(transport.mock.calls.map(([request]) => request.token)).toEqual([
      'first.token',
      'first.token',
      'second.token',
      'second.token',
    ]);
    await client.close();
    const missing = createUploadBackendClient({ ca: '', clock: () => clock, transport });
    await missing.refresh();
    expect(missing.current().state).toBe('unknown');
    await missing.close();
    expect(transport).toHaveBeenCalledTimes(4);
  });
  it('has a finite deadline and no accumulating work when token IO cannot complete', async () => {
    jest.useFakeTimers();
    try {
      const readToken = jest.fn(() => new Promise<string>(() => undefined));
      const client = createUploadBackendClient({
        binding,
        ca: 'ca',
        clock: () => clock,
        readToken,
      });
      const pending = client.refresh();
      await jest.advanceTimersByTimeAsync(3000);
      await pending;
      await client.refresh();
      expect(readToken).toHaveBeenCalledTimes(1);
      expect(client.current().state).toBe('unknown');
      await client.close();
    } finally {
      jest.useRealTimers();
    }
  });
  it('destroys an oversized HTTP response on the fixed verified Kubernetes origin', async () => {
    const req = Object.assign(new EventEmitter(), { end: jest.fn(), destroy: jest.fn() });
    const response = Object.assign(new PassThrough(), {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
    });
    (request as jest.Mock).mockImplementation((_options, callback) => {
      queueMicrotask(() => {
        callback(response);
        response.end(Buffer.alloc(65537));
      });
      return req;
    });
    await expect(
      fetchUploadSafetyConfigMap({
        name: binding.observers[0].name,
        token: 'fixture.token',
        ca: 'fixture-ca',
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('oversize_upload_safety');
    expect(req.destroy).toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        hostname: 'kubernetes.default.svc',
        port: 443,
        method: 'GET',
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
        agent: false,
        path: '/api/v1/namespaces/cortex-objectstore/configmaps/cortex-upload-safety-cpu-2',
      }),
      expect.any(Function),
    );
  });
});
