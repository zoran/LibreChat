/** Pure finite operator contract. Topology comes from independent owner composition, never receipts. */
export type UploadActivationGatewayContext = readonly string[];

function requireValue(
  condition: unknown,
  code: 'INVALID_INPUT' | 'INCOMPLETE' = 'INVALID_INPUT',
): asserts condition {
  if (!condition) throw Object.assign(new Error(code), { code });
}

function record(value: unknown): value is Record<string, unknown> {
  return (
    value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
  );
}

function shape(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  requireValue(
    record(value) &&
      Object.keys(value).length === keys.length &&
      keys.every((key) => Object.prototype.hasOwnProperty.call(value, key)),
  );
}

function context(value: unknown): UploadActivationGatewayContext {
  requireValue(Array.isArray(value) && value.length === 2);
  for (const endpoint of value) {
    requireValue(typeof endpoint === 'string');
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw Object.assign(new Error('INVALID_INPUT'), { code: 'INVALID_INPUT' });
    }
    requireValue(
      url.protocol === 'https:' &&
        url.hostname.length > 0 &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname === '/' &&
        url.href === endpoint + '/',
    );
  }
  requireValue(value[0] !== value[1]);
  return Object.freeze([...value]);
}

/** The existing 16 KiB public operation-context bound; no environment or application state access. */
export function parseUploadActivationGatewayContext(raw: unknown): UploadActivationGatewayContext {
  requireValue(typeof raw === 'string' && Buffer.byteLength(raw, 'utf8') <= 16 * 1024);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('INVALID_INPUT'), { code: 'INVALID_INPUT' });
  }
  return context(value);
}

/** Validate observed endpoints and bucket versioning against independent expected identity. */
export function validateUploadActivationGateways(
  observed: unknown,
  expected: UploadActivationGatewayContext,
  buckets: readonly string[],
): void {
  const endpoints = context(expected);
  requireValue(
    Array.isArray(buckets) &&
      buckets.length === 2 &&
      buckets.every((bucket) => typeof bucket === 'string' && bucket.length > 0) &&
      buckets[0] !== buckets[1],
  );
  requireValue(Array.isArray(observed) && observed.length === endpoints.length);
  const states: Record<string, unknown>[] = [];
  observed.forEach((gateway: unknown, index: number) => {
    shape(gateway, ['endpoint', 'versioning']);
    shape(gateway.versioning, buckets);
    const versioning = gateway.versioning;
    requireValue(
      gateway.endpoint === endpoints[index] &&
        buckets.every((bucket) =>
          ['Disabled', 'Enabled', 'Suspended'].includes(versioning[bucket] as string),
        ),
    );
    states.push(versioning);
  });
  requireValue(
    buckets.every((bucket) => states[0][bucket] === states[1][bucket]),
    'INCOMPLETE',
  );
}
