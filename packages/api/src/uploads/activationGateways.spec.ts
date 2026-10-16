import {
  parseUploadActivationGatewayContext,
  validateUploadActivationGateways,
} from './activationGateways';

const endpoints = ['https://current-a.example:8333', 'https://current-b.example:8333'];
const buckets = ['managed', 'qualification'];
const observations = () =>
  endpoints.map((endpoint) => ({
    endpoint,
    versioning: { managed: 'Disabled', qualification: 'Disabled' },
  }));

describe('independent operator gateway context', () => {
  test('parses a defensive immutable context and accepts the matching current observation', () => {
    const value = parseUploadActivationGatewayContext(JSON.stringify(endpoints));
    expect(value).toEqual(endpoints);
    expect(Object.isFrozen(value)).toBe(true);
    expect(() => validateUploadActivationGateways(observations(), value, buckets)).not.toThrow();
  });

  test.each([
    undefined,
    null,
    [],
    '{}',
    'null',
    '[',
    '[]',
    JSON.stringify([endpoints[0]]),
    JSON.stringify([...endpoints, endpoints[0]]),
    JSON.stringify([endpoints[0], endpoints[0]]),
    JSON.stringify([false, endpoints[1]]),
    ' '.repeat(16385),
  ])('rejects missing or malformed context %p', (raw) => {
    expect(() => parseUploadActivationGatewayContext(raw)).toThrow('INVALID_INPUT');
  });

  test.each([
    'http://foreign.example:8333',
    'https://user:password@foreign.example:8333',
    'https://foreign.example:8333/path',
    'https://foreign.example:8333?query',
    'https://foreign.example:8333#fragment',
    'https://foreign.example:8333/',
    'HTTPS://foreign.example:8333',
    'not-a-url',
  ])('rejects noncanonical or unsafe endpoint %s', (endpoint) => {
    expect(() =>
      parseUploadActivationGatewayContext(JSON.stringify([endpoint, endpoints[1]])),
    ).toThrow('INVALID_INPUT');
  });

  test.each([
    'historical',
    'foreign',
    'reordered',
    'missing',
    'duplicate',
    'extra',
    'shape',
    'version',
    'bucket',
  ])('rejects %s observed gateways against the independent expectation', (kind) => {
    const value: any[] = observations();
    if (kind === 'historical' || kind === 'foreign')
      value[0].endpoint = 'https://' + kind + '.example:8333';
    if (kind === 'reordered') value.reverse();
    if (kind === 'missing') value.pop();
    if (kind === 'duplicate') value[1] = value[0];
    if (kind === 'extra') value.push(value[0]);
    if (kind === 'shape') value[0].extra = true;
    if (kind === 'version') value[0].versioning.managed = 'Unknown';
    if (kind === 'bucket') delete value[0].versioning.managed;
    expect(() => validateUploadActivationGateways(value, endpoints, buckets)).toThrow(
      'INVALID_INPUT',
    );
  });

  test('retains versioning disagreement as incomplete and admits each known equal state', () => {
    const value = observations();
    value[1].versioning.managed = 'Enabled';
    expect(() => validateUploadActivationGateways(value, endpoints, buckets)).toThrow('INCOMPLETE');
    for (const state of ['Disabled', 'Enabled', 'Suspended']) {
      value.forEach((gateway) => {
        gateway.versioning.managed = state;
      });
      expect(() => validateUploadActivationGateways(value, endpoints, buckets)).not.toThrow();
    }
  });

  test('direct callers cannot omit or forge a malformed expectation', () => {
    expect(() =>
      validateUploadActivationGateways(observations(), undefined as any, buckets),
    ).toThrow('INVALID_INPUT');
    expect(() =>
      validateUploadActivationGateways(observations(), endpoints, ['managed', 'managed']),
    ).toThrow('INVALID_INPUT');
  });
});
