/** One authorized service origin and one DNS-selected backend for a client's entire lifetime. */
import { isIP } from 'node:net';
import { promises as dns } from 'node:dns';
import type { LookupFunction } from 'node:net';
import type { LookupAddress } from 'node:dns';

const failure = () =>
  Object.assign(new Error('service_endpoint_unavailable'), { code: 'ENOTFOUND' });

/** Requires headless service DNS in production; pinning a ClusterIP cannot remove its backend LB. */
export function createPinnedServiceEndpoint(options: {
  endpoint: string;
  allowedHosts: readonly string[];
  /** Trusted DNS fixture seam. Request data must never choose this resolver or another origin. */
  resolve?: (hostname: string) => Promise<readonly LookupAddress[]>;
}): { readonly url: URL; lookup: LookupFunction } {
  let origin: string;
  let hostname: string;
  try {
    const url = new URL(options.endpoint);
    if (
      url.protocol !== 'https:' ||
      !Array.isArray(options.allowedHosts) ||
      options.allowedHosts.length === 0 ||
      options.allowedHosts.length > 128 ||
      new Set(options.allowedHosts).size !== options.allowedHosts.length ||
      options.allowedHosts.some(
        (host) => typeof host !== 'string' || new URL(`https://${host}`).hostname !== host,
      ) ||
      !options.allowedHosts.includes(url.hostname) ||
      ![url.origin, url.origin + '/'].includes(options.endpoint)
    )
      throw failure();
    origin = url.origin;
    hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  } catch {
    throw failure();
  }
  const resolve =
    options.resolve ?? ((host: string) => dns.lookup(host, { all: true, verbatim: true }));
  let flight: Promise<LookupAddress> | undefined;
  function address(): Promise<LookupAddress> {
    if (!flight) {
      // Never clear this flight: both success and failure are terminal for this client.
      flight = Promise.resolve()
        .then(async () => {
          const family = isIP(hostname);
          if (family) return { address: hostname, family };
          const answers = await resolve(hostname);
          const first = Array.isArray(answers) ? answers[0] : undefined;
          if (
            !first ||
            typeof first.address !== 'string' ||
            first.address.includes('%') ||
            ![4, 6].includes(first.family) ||
            isIP(first.address) !== first.family
          )
            throw failure();
          return { address: first.address, family: first.family };
        })
        .catch(() => {
          throw failure();
        });
    }
    return flight;
  }
  const lookup: LookupFunction = (host, query, callback) => {
    // net.connect uses LookupOptions; also preserve dns.lookup's numeric family convention.
    const requested = typeof query === 'number' ? query : (query?.family ?? 0);
    let family = -1;
    if (typeof requested === 'number') family = requested;
    else if (requested === 'IPv4') family = 4;
    else if (requested === 'IPv6') family = 6;
    const all = typeof query === 'object' && query?.all === true;
    if (host !== hostname || ![0, 4, 6].includes(family)) {
      queueMicrotask(() => callback(failure(), all ? [] : ''));
      return;
    }
    void address().then(
      (selected) => {
        if (family !== 0 && family !== selected.family) {
          callback(failure(), all ? [] : '');
          return;
        }
        if (all) callback(null, [{ ...selected }]);
        else callback(null, selected.address, selected.family);
      },
      () => callback(failure(), all ? [] : ''),
    );
  };
  return {
    // URL setters mutate even a frozen URL. Give consumers a fresh view of the fixed origin.
    get url() {
      return new URL(origin);
    },
    lookup,
  };
}
