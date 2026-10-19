/** Shared source authority exercised through actual context preparation, never a provider success mock. */
import { createHash } from 'node:crypto';
import type { UploadCleanupTask, UploadPrincipal } from 'librechat-data-provider';
import type { ManagedSourceRecord } from './managedSource';
import type { ServerRequest } from '~/types';
import { bindManagedContextSources, createManagedSourceResolver } from './managedSource';
import { extractFileContext } from './context';

const principal: UploadPrincipal = {
  tenantId: 'tenant-a',
  userId: 'owner-a',
  authentication: 'verified-email',
};
const epoch = Date.parse('2026-10-18T00:00:00Z');
const policy = 'c'.repeat(64);

function fixture() {
  let clock = epoch;
  const text = 'The first month costs 1760 EUR.';
  const bytes = Buffer.byteLength(text);
  const sha256 = createHash('sha256').update(text).digest('hex');
  const record: ManagedSourceRecord = {
    file_id: 'source-a',
    uploadOperationId: 'source-a',
    tenantId: principal.tenantId,
    user: principal.userId,
    filename: 'Offer.txt',
    type: 'text/plain',
    source: 's3',
    bytes,
    embedded: true,
    llmDeliveryPath: 'text',
    status: 'ready',
    retentionAcceptedAt: new Date(epoch - 1),
    expiredAt: new Date(epoch + 60_000),
    storageKey: 'private-original',
    text,
    documentStructure: {
      version: 1,
      source: { sha256, bytes, mediaType: 'text/plain' },
      extractor: { name: 'synthetic', version: '1' },
      pages: [],
      elements: [
        { id: 'e1', kind: 'paragraph', start: 0, end: text.length, page: null, parentId: null },
      ],
      quality: { status: 'complete', warnings: [] },
    },
    securityApproval: {
      version: 1,
      decision: 'approved',
      policySha256: policy,
      subject: {
        tenantId: principal.tenantId,
        userId: principal.userId,
        operationId: 'source-a',
        transferGeneration: 1,
        mediaType: 'text/plain',
        bytes,
        sha256,
      },
      scannerVersion: 'synthetic/1',
      checkedAt: new Date(epoch - 1).toISOString(),
      coverage: { complete: true, pages: 1, parts: 1 },
    },
  };
  const operation = {
    id: 'source-a',
    fileId: 'source-a',
    scope: { kind: 'personal' as const },
    state: 'ready' as const,
    canUseInComposer: true,
    actualBytes: bytes,
    expiresAt: new Date(epoch + 60_000).toISOString(),
  };
  const task: UploadCleanupTask = {
    operationId: 'source-a',
    fileId: 'source-a',
    state: 'ready',
    principal,
    generation: 1,
    attemptGeneration: 1,
    writerStopped: true,
    localCopiesAbsent: true,
    original: {
      outcome: 'durable',
      source: 's3',
      bytes,
      storageKey: 'private-original',
      filepath: '/api/files/managed/source-a',
      integrity: {
        version: 1,
        algorithm: 'sha256',
        sha256,
        chunkBytes: 262144,
        chunkSha256: [sha256],
      },
    },
  };
  const req = {
    method: 'POST',
    headers: { origin: 'https://cortex.example' },
    user: { id: principal.userId, tenantId: principal.tenantId },
    body: {},
    config: { fileConfig: { fileTokenLimit: 1000 } },
  } as ServerRequest;
  const ports = {
    allowedOrigins: ['https://cortex.example'],
    principal: jest.fn(async () => principal),
    operation: jest.fn(async () => structuredClone(operation)),
    file: jest.fn(async () => JSON.parse(JSON.stringify(record))),
    original: jest.fn(async () => JSON.parse(JSON.stringify(task))),
    policySha256: () => policy,
    storage: { read: jest.fn(), put: jest.fn(), remove: jest.fn() },
    now: () => clock,
  };
  const resolver = createManagedSourceResolver(ports);
  const context = (tokenCountFn = async (value: string) => value.length) =>
    extractFileContext({
      attachments: [
        {
          file_id: 'source-a',
          filename: 'forged-name',
          text: 'forged-body',
          llmDeliveryPath: 'text',
        },
      ],
      sources: bindManagedContextSources(req, resolver, true),
      req,
      tokenCountFn,
    });
  return {
    record,
    operation,
    task,
    req,
    ports,
    resolver,
    context,
    setClock: (at: number) => {
      clock = at;
    },
  };
}

it('uses the canonical source in normal context and preserves honest prefix coverage', async () => {
  const f = fixture();
  const result = await f.context();
  expect(result).toContain('1760 EUR');
  expect(result).toContain('Offer.txt');
  expect(result).not.toContain('forged');
  expect(result).toContain('"start":0');
  expect(result).toContain('"complete":true');
  expect(result).toContain('"extraction":"not_assessed"');
  expect(f.ports.file).toHaveBeenCalledTimes(2);
  expect(f.ports.original).toHaveBeenCalledTimes(2);
  expect(f.ports.storage.read).not.toHaveBeenCalled();
});

it.each(['owner', 'tenant', 'origin', 'identity', 'request-tenant'])(
  'rejects a changed %s before any source disclosure',
  async (field) => {
    const f = fixture();
    if (field === 'owner') f.record.user = 'other-owner';
    if (field === 'tenant') f.record.tenantId = 'other-tenant';
    if (field === 'origin') f.req.headers.origin = 'https://untrusted.example';
    if (field === 'identity') {
      if (!f.req.user) throw new Error('Missing fixture identity');
      f.req.user.id = 'other-owner';
    }
    if (field === 'request-tenant') {
      if (!f.req.user) throw new Error('Missing fixture identity');
      f.req.user.tenantId = 'other-tenant';
    }
    if (field === 'identity' || field === 'request-tenant') {
      await expect(f.resolver.authorize(f.req)).rejects.toMatchObject({ code: 'forbidden' });
    }
    await expect(f.context()).rejects.toBeDefined();
    expect(f.ports.storage.read).not.toHaveBeenCalled();
  },
);

it.each(['text', 'approval', 'original', 'revocation', 'expiry', 'principal', 'unknown-read'])(
  'denies %s changed while token preparation awaits',
  async (field) => {
    const f = fixture();
    let changed = false;
    const coverage = jest.fn();
    await expect(
      extractFileContext({
        attachments: [{ file_id: 'source-a', filename: '', text: '', llmDeliveryPath: 'text' }],
        sources: bindManagedContextSources(f.req, f.resolver, true),
        req: f.req,
        onSourceCoverage: coverage,
        tokenCountFn: async (value) => {
          if (!changed) {
            changed = true;
            if (field === 'text') f.record.text = 'Different bytes with the same original.';
            if (field === 'approval') f.record.securityApproval = undefined;
            if (field === 'original') f.task.original!.storageKey = 'replaced-original';
            if (field === 'revocation') f.record.deletionRequestedAt = new Date(epoch);
            if (field === 'expiry') f.setClock(epoch + 60_000);
            if (field === 'principal')
              f.ports.principal.mockResolvedValue({ ...principal, userId: 'other' });
            if (field === 'unknown-read')
              f.ports.operation.mockRejectedValue(new Error('unconfirmed read'));
          }
          return value.length;
        },
      }),
    ).rejects.toBeDefined();
    expect(coverage).not.toHaveBeenCalled();
  },
);

it('rejects malformed present structure instead of falling back to legacy text', async () => {
  const f = fixture();
  f.record.documentStructure = { version: 1 };
  await expect(f.context()).rejects.toMatchObject({ code: 'not_found' });
});

it('checks live operation availability after the original-receipt await', async () => {
  const f = fixture();
  f.ports.original.mockImplementation(async () => {
    f.operation.canUseInComposer = false;
    return JSON.parse(JSON.stringify(f.task));
  });
  await expect(f.context()).rejects.toMatchObject({ code: 'not_found' });
});

it('retains immutable detached data and rejects copied handles', async () => {
  const f = fixture();
  const access = await f.resolver.resolve(f.req, 'source-a', { text: true });
  expect(Object.isFrozen(access.document!.structure.elements[0])).toBe(true);
  f.record.text = 'replaced';
  expect(access.file.text).toContain('1760 EUR');
  await expect(f.resolver.revalidate(f.req, { ...access })).rejects.toMatchObject({
    code: 'not_found',
  });
  await expect(f.resolver.revalidate(f.req, access)).rejects.toMatchObject({ code: 'not_found' });
});

it('denies an aborted read and never starts a new source read', async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort();
  await expect(
    f.resolver.resolve(f.req, 'source-a', { text: true, signal: controller.signal }),
  ).rejects.toBeDefined();
  expect(f.ports.file).not.toHaveBeenCalled();
});

it('a missing managed runtime cannot fall back to caller-supplied text', async () => {
  const f = fixture();
  await expect(
    extractFileContext({
      attachments: [
        { file_id: 'source-a', filename: 'forged', text: 'forged', llmDeliveryPath: 'text' },
      ],
      sources: bindManagedContextSources(f.req, undefined, true),
      req: f.req,
      tokenCountFn: (value) => value.length,
    }),
  ).rejects.toMatchObject({ code: 'unavailable' });
  expect(bindManagedContextSources(f.req, undefined, false)).toBeUndefined();
});
