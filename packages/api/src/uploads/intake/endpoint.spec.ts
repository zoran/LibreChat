/** Controlled DNS boundary; production origin/pin validation and Node lookup semantics are real. */
import type { LookupAddress, LookupOptions } from 'node:dns';
import { createPinnedServiceEndpoint } from './endpoint';

const endpoint = 'https://scanner.test:9443';
const host = 'scanner.test';
const create = (resolve?: (hostname: string) => Promise<readonly LookupAddress[]>) =>
  createPinnedServiceEndpoint({ endpoint, allowedHosts: [host], resolve });
function lookup(pinned: ReturnType<typeof create>, options: LookupOptions = {}, hostname = host) {
  return new Promise<{ address: string | LookupAddress[]; family?: number }>((resolve, reject) => {
    pinned.lookup(hostname, options, (error, address, family) => {
      if (error) reject(error);
      else resolve({ address, family });
    });
  });
}

it('shares one pending DNS flight, pins one detached answer and preserves all/family callback semantics', async () => {
  let finish!: (addresses: LookupAddress[]) => void;
  const resolution = new Promise<LookupAddress[]>((resolve) => {
    finish = resolve;
  });
  const resolve = jest.fn(() => resolution);
  const pinned = create(resolve);
  const first = lookup(pinned);
  const second = lookup(pinned, { all: true });
  await Promise.resolve();
  expect(resolve).toHaveBeenCalledTimes(1);
  const answers = [
    { address: '127.0.0.1', family: 4 },
    { address: '127.0.0.2', family: 4 },
  ];
  finish(answers);
  expect(await first).toEqual({ address: '127.0.0.1', family: 4 });
  const all = await second;
  expect(all).toEqual({ address: [{ address: '127.0.0.1', family: 4 }] });
  answers[0].address = '127.0.0.2';
  if (!Array.isArray(all.address)) throw new Error('Expected Node all result');
  all.address[0].address = '127.0.0.3';
  expect(await lookup(pinned, { family: 'IPv4' })).toEqual({ address: '127.0.0.1', family: 4 });
  await expect(lookup(pinned, { family: 6 })).rejects.toThrow('service_endpoint_unavailable');
  await expect(lookup(pinned, { family: 5 })).rejects.toThrow();
  expect(resolve).toHaveBeenCalledTimes(1);
});

it.each([
  { addresses: [] },
  { addresses: [{ address: 'not-an-ip', family: 4 }] },
  { addresses: [{ address: '::1', family: 4 }] },
  { addresses: [{ address: '127.0.0.1', family: 5 }] },
  { addresses: [{ address: 'fe80::1%lo', family: 6 }] },
])('keeps malformed DNS answers terminal without another resolution %#', async ({ addresses }) => {
  const resolve = jest.fn(async () => addresses);
  const pinned = create(resolve);
  await expect(lookup(pinned)).rejects.toThrow('service_endpoint_unavailable');
  await expect(lookup(pinned)).rejects.toThrow('service_endpoint_unavailable');
  expect(resolve).toHaveBeenCalledTimes(1);
});

it('keeps resolver failure terminal and content-free', async () => {
  const resolve = jest.fn(async () => {
    throw new Error('private DNS details');
  });
  const pinned = create(resolve);
  await expect(lookup(pinned)).rejects.toMatchObject({
    message: 'service_endpoint_unavailable',
    code: 'ENOTFOUND',
  });
  await expect(lookup(pinned)).rejects.toThrow(/^service_endpoint_unavailable$/);
  expect(resolve).toHaveBeenCalledTimes(1);
});

it.each([
  ['https://127.0.0.1:9443', '127.0.0.1', '127.0.0.1', 4],
  ['https://[::1]:9443', '[::1]', '::1', 6],
] as const)('keeps literal IP %s fixed without DNS', async (url, allowed, address, family) => {
  const resolve = jest.fn(async () => [{ address: '127.0.0.2', family: 4 }]);
  const pinned = createPinnedServiceEndpoint({ endpoint: url, allowedHosts: [allowed], resolve });
  expect(await lookup(pinned, { all: true, family }, address)).toEqual({
    address: [{ address, family }],
  });
  expect(resolve).not.toHaveBeenCalled();
});

it('detaches the origin and allowlist and refuses lookup for another hostname', async () => {
  const allowedHosts = [host];
  const resolve = jest.fn(async () => [{ address: '127.0.0.1', family: 4 }]);
  const pinned = createPinnedServiceEndpoint({ endpoint, allowedHosts, resolve });
  allowedHosts[0] = 'other.test';
  pinned.url.hostname = 'other.test';
  expect(pinned.url.origin).toBe(endpoint);
  await expect(lookup(pinned, {}, 'other.test')).rejects.toThrow();
  expect(resolve).not.toHaveBeenCalled();
  expect(await lookup(pinned)).toMatchObject({ address: '127.0.0.1' });
});

it.each([
  'http://scanner.test',
  'https://user:password@scanner.test',
  'https://scanner.test/path',
  'https://scanner.test?query',
  'https://scanner.test#fragment',
  'https://unlisted.test',
])('rejects a non-authorized exact HTTPS origin %s', (url) => {
  expect(() => createPinnedServiceEndpoint({ endpoint: url, allowedHosts: [host] })).toThrow();
});

it.each([
  { allowedHosts: [] },
  { allowedHosts: [host, host] },
  { allowedHosts: [host, 'other.test/path'] },
  { allowedHosts: [host, 'user@other.test'] },
])('rejects malformed allowed host configuration %#', ({ allowedHosts }) => {
  expect(() => createPinnedServiceEndpoint({ endpoint, allowedHosts })).toThrow();
});
