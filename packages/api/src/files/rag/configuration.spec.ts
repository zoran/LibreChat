import {
  configurationBytes,
  configurationDigest,
  configurationFixture,
  deploymentInput,
} from './configuration.fixture';
import { parseManagedFileDeploymentConfiguration } from './configuration';

const unavailable = {
  message: 'Managed retrieval configuration unavailable',
  code: 'managed_retrieval_configuration_unavailable',
};

/** Actual File validators execute; synthetic evidence is never represented as native admission. */
it('preserves exact current and retained policies in a detached, deeply immutable snapshot', () => {
  const { input, expected } = configurationFixture();
  const { policySnapshot } = input.trustedFile.retrieval;
  policySnapshot.purge.push({
    ...policySnapshot.content,
    backendIdentity: 'retained-backend',
    writerEpoch: 2,
    provenanceSha256: '8'.repeat(64),
  });
  const bytes = configurationBytes(input);
  const value = parseManagedFileDeploymentConfiguration(bytes, {
    ...expected,
    configurationSha256: configurationDigest(bytes),
  });
  expect(value).toEqual(input.trustedFile);
  input.trustedFile.retrieval.transport.url = 'https://changed.invalid';
  bytes.fill(0);
  expect(value.retrieval!.transport.url).toBe('https://retrieval.invalid');
  expect(value.retrieval!.policySnapshot.purge[1].provenanceSha256).toBe('8'.repeat(64));
  for (const object of [
    value,
    value.retrieval,
    value.retrieval!.profile,
    value.retrieval!.policySnapshot.purge,
    value.retrieval!.policySnapshot.purge[0],
    value.retrieval!.policySnapshot.purge[1],
    value.retrieval!.transport,
  ]) {
    expect(Object.isFrozen(object)).toBe(true);
  }
});

it.each(['sourceRevision', 'imageDigest', 'namespaceUid', 'configurationSha256'] as const)(
  'requires independent exact %s expectation',
  (field) => {
    const { bytes, expected } = configurationFixture();
    const different = {
      sourceRevision: 'c'.repeat(40),
      imageDigest: 'sha256:' + 'd'.repeat(64),
      namespaceUid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      configurationSha256: 'f'.repeat(64),
    };
    expect(() =>
      parseManagedFileDeploymentConfiguration(bytes, {
        ...expected,
        [field]: different[field],
      }),
    ).toThrow(expect.objectContaining(unavailable));
  },
);

const invalidInputs: [string, (input: ReturnType<typeof deploymentInput>) => void][] = [
  ['unknown envelope field', (v) => Object.assign(v, { admitted: true })],
  ['unknown File field', (v) => Object.assign(v.trustedFile, { complete: true })],
  [
    'unknown policy field',
    (v) => Object.assign(v.trustedFile.retrieval.policySnapshot.content, { enabled: true }),
  ],
  [
    'per-File inventory authority in deployment input',
    (v) =>
      Object.assign(v.trustedFile, {
        retrievalInventoryAuthority: {
          topologySha256: '4'.repeat(64),
          writers: [{ writerId: 'retired-writer', retirementReceiptSha256: '5'.repeat(64) }],
          backends: [
            {
              backendIdentity: v.trustedFile.retrieval.transport.backendIdentity,
              inventoryReceiptSha256: '6'.repeat(64),
            },
          ],
        },
      }),
  ],
  [
    'unsupported profile',
    (v) => {
      v.trustedFile.retrieval.profile.dimensions = 4096;
    },
  ],
  [
    'wrong generation',
    (v) => {
      v.trustedFile.retrieval.policySnapshot.content.indexGeneration = '0'.repeat(64);
    },
  ],
  [
    'wrong backend',
    (v) => {
      v.trustedFile.retrieval.transport.backendIdentity = 'another-backend';
    },
  ],
  [
    'unbound provenance',
    (v) => {
      v.trustedFile.retrieval.policySnapshot.source.provenanceSha256 = '0'.repeat(64);
    },
  ],
  [
    'missing current purge policy',
    (v) => {
      v.trustedFile.retrieval.policySnapshot.purge = [];
    },
  ],
  [
    'duplicate purge policy',
    (v) => {
      v.trustedFile.retrieval.policySnapshot.purge.push({
        ...v.trustedFile.retrieval.policySnapshot.content,
      });
    },
  ],
];
it.each(invalidInputs)('rejects %s through the actual owner validators', (_name, change) => {
  const { input, expected } = configurationFixture();
  change(input);
  const bytes = configurationBytes(input);
  expect(() =>
    parseManagedFileDeploymentConfiguration(bytes, {
      ...expected,
      configurationSha256: configurationDigest(bytes),
    }),
  ).toThrow(expect.objectContaining(unavailable));
});

it.each([
  'http://retrieval.invalid',
  'https://private:credential@retrieval.invalid',
  'https://retrieval.invalid/path',
  'https://retrieval.invalid/?token=private',
  'https://retrieval.invalid/#private',
])('rejects unsafe transport before any resource: %s', (url) => {
  const { input, expected } = configurationFixture();
  input.trustedFile.retrieval.transport.url = url;
  const bytes = configurationBytes(input);
  expect(() =>
    parseManagedFileDeploymentConfiguration(bytes, {
      ...expected,
      configurationSha256: configurationDigest(bytes),
    }),
  ).toThrow(expect.objectContaining(unavailable));
});

it.each([
  [
    'duplicate key',
    (bytes: Buffer) =>
      Buffer.from(
        bytes.toString().replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
      ),
  ],
  ['noncanonical whitespace', (bytes: Buffer) => Buffer.from(' ' + bytes.toString())],
  ['missing LF', (bytes: Buffer) => bytes.subarray(0, -1)],
  ['trailing content', (bytes: Buffer) => Buffer.concat([bytes, Buffer.from('{}')])],
  ['UTF-8 BOM', (bytes: Buffer) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes])],
  ['invalid UTF-8', (_bytes: Buffer) => Buffer.from([0xff, 0x0a])],
  ['oversized input', (_bytes: Buffer) => Buffer.alloc(65_537, 0x20)],
] as const)('rejects %s even with its exact externally supplied byte hash', (_name, change) => {
  const fixture = configurationFixture();
  const bytes = change(fixture.bytes);
  expect(() =>
    parseManagedFileDeploymentConfiguration(bytes, {
      ...fixture.expected,
      configurationSha256: configurationDigest(bytes),
    }),
  ).toThrow(expect.objectContaining(unavailable));
});

it('redacts raw mounted content and parser diagnostics', () => {
  const { expected } = configurationFixture();
  const bytes = Buffer.from('{private-material-should-never-be-disclosed');
  try {
    parseManagedFileDeploymentConfiguration(bytes, {
      ...expected,
      configurationSha256: configurationDigest(bytes),
    });
    throw new Error('Expected rejection');
  } catch (error) {
    expect(error).toMatchObject(unavailable);
    expect(String(error)).not.toContain('private-material');
  }
});
