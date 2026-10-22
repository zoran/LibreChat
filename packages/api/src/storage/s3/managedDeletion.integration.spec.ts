import { once } from 'node:events';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { S3Client } from '@aws-sdk/client-s3';
import { createHash, createHmac } from 'node:crypto';
import { createManagedDeletionAdapter } from './managedDeletion';

const accessKeyId = 'LOOPBACK_FIXTURE_ACCESS';
const secretAccessKey = 'test-loopback-fixture-secret-not-a-credential';
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const hmac = (key: string | Buffer, v: string) => createHmac('sha256', key).update(v).digest();
const encode = (s: string) =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
const request = {
  protocol: 1 as const,
  requestId: 'persisted-request',
  generation: '2',
  authorityBindingSHA256: 'a'.repeat(64),
  acceptedObjectSHA256: 'b'.repeat(64),
};
const bucket = 'private-bucket';
const key = 'managed-uploads/user/operation.2__original';

it('uses real S3 SigV4 for begin/status, exact replay, bounded failures and original cancellation', async () => {
  let mode = 'pending';
  let retries = 0;
  let signatureFailure: unknown;
  const received: { method: string; request: Record<string, unknown>; body: string }[] = [];
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer(async (req, res) => {
    try {
      let body = '';
      for await (const chunk of req) body += chunk;
      const url = new URL(req.url!, 'http://fixture.invalid');
      assert.equal(url.pathname, '/' + bucket + '/' + key);
      assert.equal(url.searchParams.get('cortex-delete'), '1');
      const auth = req.headers.authorization!;
      const match =
        /^AWS4-HMAC-SHA256 Credential=([^/]+)\/([^,]+), SignedHeaders=([^,]+), Signature=([a-f0-9]+)$/.exec(
          auth,
        )!;
      assert.ok(match);
      assert.equal(match[1], accessKeyId);
      const [day, region, service] = match[2].split('/');
      assert.equal(region, 'us-east-1');
      assert.equal(service, 's3');
      const headers = match[3]
        .split(';')
        .map((k) => k + ':' + String(req.headers[k]).trim().replace(/\s+/g, ' ') + '\n')
        .join('');
      const query = [...url.searchParams.entries()]
        .map(([k, v]) => [encode(k), encode(v)])
        .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]))
        .map((v) => v.join('='))
        .join('&');
      const payload = String(req.headers['x-amz-content-sha256']);
      assert.equal(payload, hash(body));
      const canonical = [req.method, url.pathname, query, headers, match[3], payload].join('\n');
      const signingKey = hmac(
        hmac(hmac(hmac('AWS4' + secretAccessKey, day), region), service),
        'aws4_request',
      );
      const expected = hmac(
        signingKey,
        ['AWS4-HMAC-SHA256', req.headers['x-amz-date'], match[2], hash(canonical)].join('\n'),
      ).toString('hex');
      assert.equal(match[4], expected);
      const input =
        req.method === 'POST'
          ? JSON.parse(body)
          : Object.fromEntries(
              [...url.searchParams.entries()]
                .filter(([k]) => k !== 'cortex-delete')
                .map(([k, v]) => [k, k === 'protocol' ? Number(v) : v]),
            );
      received.push({ method: req.method!, request: input, body });
      if (url.searchParams.get('action') === 'consume') {
        assert.equal(req.method, 'POST');
        const canonical = JSON.stringify(
          Object.fromEntries(
            Object.entries(input.terminalReceipt).sort(([a], [b]) => {
              if (a < b) return -1;
              if (a > b) return 1;
              return 0;
            }),
          ),
        );
        assert.equal(input.receiptSHA256, hash(canonical));
        assert.equal(input.terminalReceipt.proofSHA256, 'c'.repeat(64));
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            state: 'recorded',
            obligationId: input.terminalReceipt.obligationId,
            receiptSHA256: mode === 'consume-wrong' ? 'd'.repeat(64) : input.receiptSHA256,
            consumerCommitId: input.consumerCommitId,
          }),
        );
        return;
      }
      if (mode === 'retry' && retries++ === 0) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      const output: Record<string, unknown> = {
        ...request,
        bucket,
        key,
        state: mode === 'retry' ? 'pending' : mode,
        obligationId: 'opaque-obligation',
      };
      if (mode === 'durable_delete_complete')
        Object.assign(output, { aggregateRevision: '7', proofSHA256: 'c'.repeat(64) });
      if (mode === 'wrong-binding')
        Object.assign(output, {
          state: 'durable_delete_complete',
          aggregateRevision: '7',
          proofSHA256: 'c'.repeat(64),
          requestId: 'other',
        });
      if (mode === 'pending-proof')
        Object.assign(output, {
          state: 'pending',
          aggregateRevision: '7',
          proofSHA256: 'c'.repeat(64),
        });
      if (mode === 'absent404') {
        res.writeHead(404);
        res.end();
        return;
      }
      res.setHeader('content-type', 'application/json');
      if (mode === 'oversized') {
        res.end(' '.repeat(16385));
        return;
      }
      if (mode === 'truncated') {
        res.setHeader('content-length', '2000');
        res.write('{');
        res.socket!.destroy();
        return;
      }
      if (mode === 'hold') {
        res.write('{');
        return;
      }
      res.end(JSON.stringify(output));
    } catch (error) {
      signatureFailure = error;
      res.writeHead(500);
      res.end();
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as import('node:net').AddressInfo;
  const client = new S3Client({
    endpoint: `http://127.0.0.1:${address.port}`,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
    maxAttempts: 2,
  });
  const adapter = createManagedDeletionAdapter(client, bucket);
  const input = () => ({
    binding: { ...request, bucket, key },
    key,
    request,
    signal: new AbortController().signal,
    deadlineAtMs: Date.now() + 2000,
  });
  try {
    assert.equal((await adapter.begin(input())).state, 'pending');
    assert.equal((await adapter.begin(input())).state, 'pending');
    assert.equal(received[0].body, received[1].body);
    assert.equal((await adapter.observe(input())).state, 'pending');
    assert.equal(received[2].method, 'GET');
    assert.deepEqual(received[2].request, request);
    mode = 'retry';
    const retryStart = received.length;
    assert.equal((await adapter.begin(input())).state, 'pending');
    assert.equal(received.length, retryStart + 2);
    assert.equal(received[retryStart].body, received[retryStart + 1].body);
    mode = 'namespace_absent';
    assert.equal((await adapter.observe(input())).state, 'namespace_absent');
    mode = 'durable_delete_complete';
    assert.equal((await adapter.observe(input())).state, 'durable_delete_complete');
    assert.equal(
      (await adapter.observe({ ...input(), request: { ...request, obligationId: 'different' } }))
        .state,
      'unknown',
    );
    for (mode of [
      'unknown',
      'wrong-binding',
      'pending-proof',
      'oversized',
      'absent404',
      'truncated',
    ])
      assert.equal((await adapter.observe(input())).state, 'unknown', mode);
    const receipt = {
      ...request,
      bucket,
      key,
      state: 'durable_delete_complete' as const,
      obligationId: 'opaque-obligation',
      aggregateRevision: '7',
      proofSHA256: 'c'.repeat(64),
    };
    mode = 'consume';
    const consume = { ...input(), receipt, consumerCommitId: 'persisted-local-commit' };
    const acknowledged = await adapter.acknowledgeDeletionConsumed(consume);
    assert.equal(acknowledged.state, 'recorded');
    assert.deepEqual(await adapter.acknowledgeDeletionConsumed(consume), acknowledged);
    mode = 'consume-wrong';
    assert.equal((await adapter.acknowledgeDeletionConsumed(consume)).state, 'unknown');
    const before = received.length;
    assert.deepEqual(adapter.describe({ key, request }), { ...request, bucket, key });
    assert.equal(received.length, before);
    await assert.rejects(
      adapter.begin({ ...input(), binding: { ...request, bucket: 'changed', key } }),
      /binding mismatch/,
    );
    assert.equal(received.length, before);
    assert.equal(
      (await adapter.begin({ ...input(), deadlineAtMs: Date.now() - 1 })).state,
      'unknown',
    );
    assert.equal(received.length, before);
    mode = 'hold';
    assert.equal(
      (await adapter.observe({ ...input(), deadlineAtMs: Date.now() + 80 })).state,
      'unknown',
    );
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 80);
    try {
      assert.equal((await adapter.begin({ ...input(), signal: abort.signal })).state, 'unknown');
    } finally {
      clearTimeout(timer);
    }
    expect(signatureFailure).toBeUndefined();
    assert.ok(received.every((v) => v.method === 'POST' || v.method === 'GET'));
    assert.ok(received.every((v) => v.request.requestId === request.requestId));
  } finally {
    client.destroy();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
