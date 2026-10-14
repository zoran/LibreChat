import { request } from 'node:https';
import { EventEmitter } from 'node:events';
import { createUploadSnapshotClient } from './snapshotClient';
jest.mock('node:https', () => ({ request: jest.fn() }));
const base = 1800000000000;
const expected = [{ node: 'cpu-1', pool: 'host', signal: 'cpu' as const }];
const collectors = [
  { observer: 'collector-1', url: 'https://collector-1:9446/v1/upload-resources' },
  { observer: 'collector-2', url: 'https://collector-2:9446/v1/upload-resources' },
];
function body(observer: string) {
  return {
    status: 'success',
    data: {
      resultType: 'vector',
      result: Object.entries({
        expected: 1,
        value: 0.1,
        source_time_seconds: base / 1000,
        sample_count: 4,
        resets: 0,
        healthy: 1,
        observations: 0,
      }).map(([field, value]) => ({
        metric: { __name__: `cortex_upload_resource_${field}`, observer, ...expected[0] },
        value: [base / 1000, String(value)],
      })),
    },
  };
}
describe('bounded upload snapshot refresh', () => {
  it('shares one refresh and enforces the 30-second cadence without request polling', async () => {
    let now = 0;
    const transport = jest.fn(async (url: URL) => body(url.hostname));
    const client = createUploadSnapshotClient(
      {
        collectors,
        expected,
        tls: { ca: 'fixture', cert: 'fixture', key: 'fixture' },
        clock: () => ({ nowMs: base + now, monotonicMs: now }),
      },
      transport,
    );
    await Promise.all([client.refresh(), client.refresh()]);
    expect(transport).toHaveBeenCalledTimes(2);
    await client.refresh();
    expect(transport).toHaveBeenCalledTimes(2);
    now = 30000;
    await client.refresh();
    expect(transport).toHaveBeenCalledTimes(4);
  });
  it('retains expiry on failure and makes cached snapshots unavailable after raw expiry', async () => {
    let now = 0;
    let failed = false;
    const transport = jest.fn(async (url: URL) => {
      if (failed) throw new Error('private transport details');
      return body(url.hostname);
    });
    const client = createUploadSnapshotClient(
      {
        collectors,
        expected,
        tls: { ca: 'fixture', cert: 'fixture', key: 'fixture' },
        clock: () => ({ nowMs: base + now, monotonicMs: now }),
      },
      transport,
    );
    await client.refresh();
    const expires = client.current()[0].expiresAtMs;
    failed = true;
    now = 30000;
    await client.refresh();
    expect(client.current()[0].expiresAtMs).toBe(expires);
    now = 70000;
    expect(client.current()).toEqual([]);
  });
  it('rejects arbitrary query endpoints, cleartext and duplicate collectors', () => {
    for (const url of [
      'http://collector/v1/upload-resources',
      'https://collector/api/v1/query',
      'https://collector/v1/upload-resources?query=up',
    ]) {
      expect(() =>
        createUploadSnapshotClient({
          collectors: [{ observer: 'x', url }, collectors[1]],
          expected,
          tls: { ca: 'fixture', cert: 'fixture', key: 'fixture' },
          clock: () => ({ nowMs: base, monotonicMs: 0 }),
        }),
      ).toThrow();
    }
    expect(() =>
      createUploadSnapshotClient({
        collectors: [collectors[0], { ...collectors[0], observer: 'collector-2' }],
        expected,
        tls: { ca: 'fixture', cert: 'fixture', key: 'fixture' },
        clock: () => ({ nowMs: base, monotonicMs: 0 }),
      }),
    ).toThrow();
  });
  it('enforces one combined body budget on the actual HTTPS transport without opening sockets', async () => {
    const mockRequest = request as jest.Mock;
    mockRequest.mockImplementation((url, options, callback) => {
      const req = new EventEmitter() as EventEmitter & { end: () => void };
      options.signal.addEventListener('abort', () => req.emit('error', new Error('aborted')), {
        once: true,
      });
      req.end = () => {
        const res = new EventEmitter() as EventEmitter & {
          statusCode: number;
          headers: Record<string, string>;
          destroy: () => void;
        };
        res.statusCode = 200;
        res.headers = { 'content-type': 'application/json' };
        res.destroy = () => undefined;
        callback(res);
        res.emit('data', Buffer.from(JSON.stringify(body(url.hostname)) + ' '.repeat(140000)));
        res.emit('end');
      };
      return req;
    });
    const client = createUploadSnapshotClient({
      collectors,
      expected,
      tls: { ca: 'fixture', cert: 'fixture', key: 'fixture' },
      clock: () => ({ nowMs: base, monotonicMs: 0 }),
    });
    await client.refresh();
    expect(client.current().length).toBeLessThanOrEqual(1);
    expect(
      mockRequest.mock.calls.every(
        ([, options]) => options.rejectUnauthorized === true && options.agent === false,
      ),
    ).toBe(true);
  });
  it('aborts both stalled transports at the shared deadline without retaining a timer', async () => {
    jest.useFakeTimers();
    try {
      (request as jest.Mock).mockImplementation((_url, options) => {
        const req = new EventEmitter() as EventEmitter & { end: () => void };
        req.end = () => undefined;
        options.signal.addEventListener('abort', () => req.emit('error', new Error('aborted')), {
          once: true,
        });
        return req;
      });
      const client = createUploadSnapshotClient({
        collectors,
        expected,
        tls: { ca: 'fixture', cert: 'fixture', key: 'fixture' },
        clock: () => ({ nowMs: base, monotonicMs: 0 }),
      });
      const pending = client.refresh();
      await jest.advanceTimersByTimeAsync(3000);
      await pending;
      expect(client.current()).toEqual([]);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
