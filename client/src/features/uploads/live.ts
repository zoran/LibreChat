import { SSE } from 'sse.js';
import { getTokenHeader } from 'librechat-data-provider';
import type { ManagedUploadSnapshot } from 'librechat-data-provider';
import type { QueryClient } from '@tanstack/react-query';
import { readUploadSnapshot, uploadsUrl } from './api';

type LiveOwner = {
  references: number;
  start: () => void;
  stop: () => void;
  read: (signal?: AbortSignal) => Promise<ManagedUploadSnapshot>;
  admission: () => boolean | null;
};
type Observation = {
  value: boolean;
  source: 'live' | 'http';
  generation: number;
  expiresAt: number;
};
const ownersByClient = new WeakMap<QueryClient, Map<string, LiveOwner>>();

/** Admission frames carry one advisory bit, never file data or server instructions. */
function parseStatus(event: Event & { data?: string }): boolean | null {
  if (typeof event.data !== 'string' || event.data.length > 128) return null;
  try {
    const value = JSON.parse(event.data);
    if (
      !value ||
      Array.isArray(value) ||
      Object.keys(value).length !== 1 ||
      !Object.hasOwn(value, 'admissionsPaused')
    )
      return null;
    return typeof value.admissionsPaused === 'boolean' ? value.admissionsPaused : null;
  } catch {
    return null;
  }
}

/** The existing identity owner coordinates HTTP receipts, one stream and its scheduling timer. */
function createOwner(client: QueryClient, key: string[]): LiveOwner {
  let started = false;
  let stopped = false;
  let paused = false;
  let generation = 0;
  let identityEpoch = 0;
  let sequence = 0;
  let observation: Observation | undefined;
  let stream: SSE | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let nextRefresh = 0;
  let nextConnect: number | undefined;
  let failures = 0;
  const admission = () =>
    !stopped &&
    !paused &&
    !document.hidden &&
    observation &&
    performance.now() < observation.expiresAt
      ? observation.value
      : null;
  const patchAdmission = () => {
    const query = client.getQueryCache().find<ManagedUploadSnapshot>(key, { exact: true });
    const data = query?.state.data;
    const admissionsPaused = admission();
    if (query && data && data.admissionsPaused !== admissionsPaused) {
      // A heartbeat is not a file refresh: preserve its age, errors and fetch state.
      query.setState({ data: { ...data, admissionsPaused } });
    }
  };
  const close = () => {
    generation++;
    const old = stream;
    stream = undefined;
    old?.close();
  };
  const arm = () => {
    clearTimeout(timer);
    timer = undefined;
    if (!started || stopped || paused) return;
    const wake = Math.min(nextConnect ?? Infinity, observation?.expiresAt ?? Infinity);
    if (!Number.isFinite(wake)) return;
    timer = setTimeout(
      () => {
        timer = undefined;
        if (observation && performance.now() >= observation.expiresAt) {
          observe(null, 'http');
          if (stream) reconnect();
        }
        if (nextConnect !== undefined && performance.now() >= nextConnect) {
          nextConnect = undefined;
          void connect();
        }
        arm();
      },
      Math.max(0, wake - performance.now()),
    );
  };
  const observe = (value: boolean | null, source: Observation['source']) => {
    sequence++;
    observation =
      typeof value === 'boolean' && !document.hidden
        ? {
            value,
            source,
            generation,
            expiresAt: performance.now() + (source === 'live' ? 20_000 : 75_000),
          }
        : undefined;
    patchAdmission();
    arm();
  };
  const read = async (signal?: AbortSignal): Promise<ManagedUploadSnapshot> => {
    const received = sequence;
    const epoch = identityEpoch;
    const cancelled = () => stopped || paused || signal?.aborted || epoch !== identityEpoch;
    if (cancelled()) throw new DOMException('Aborted', 'AbortError');
    try {
      const data = await readUploadSnapshot(signal);
      if (cancelled()) throw new DOMException('Aborted', 'AbortError');
      if (sequence === received) observe(data.admissionsPaused, 'http');
      return { ...data, admissionsPaused: admission() };
    } catch (error) {
      // Both HTTP readers share this fence; an older failure cannot erase a newer frame.
      if (!cancelled() && sequence === received) observe(null, 'http');
      throw error;
    }
  };
  const refresh = () => {
    nextRefresh = performance.now() + 5_000;
    // QueryClient deduplicates the initial query, reconnect and all panel subscribers.
    return client.fetchQuery(key, ({ signal }) => read(signal), { staleTime: 0, retry: false });
  };
  const hint = () => {
    if (stopped || paused || refreshTimer || document.hidden) return;
    refreshTimer = setTimeout(
      () => {
        refreshTimer = undefined;
        if (!stopped && !paused) void refresh().catch(() => undefined);
      },
      Math.max(0, nextRefresh - performance.now()),
    );
  };
  const schedule = (delay: number) => {
    nextConnect = performance.now() + delay;
    arm();
  };
  const reconnect = () => {
    if (stopped || paused) return;
    if (observation?.source === 'live' && observation.generation === generation) {
      observe(null, 'live');
    }
    close();
    failures++;
    schedule(Math.min(60_000, 15_000 * failures));
  };
  const connect = async () => {
    if (stopped || paused) return;
    close();
    const attempt = generation;
    const currentAttempt = () => !stopped && !paused && generation === attempt;
    try {
      await refresh();
      if (!currentAttempt()) return;
      if (document.hidden) {
        schedule(120_000);
        return;
      }
      const current = new SSE(`${uploadsUrl}/events`, {
        method: 'GET',
        headers: { Authorization: getTokenHeader() ?? '' },
      });
      stream = current;
      const failed = () => {
        if (currentAttempt()) reconnect();
      };
      const changed = () => {
        if (currentAttempt()) hint();
      };
      current.addEventListener('open', () => {
        if (currentAttempt()) failures = 0;
      });
      current.addEventListener('status', (event: Event & { data?: string }) => {
        if (currentAttempt() && !document.hidden) observe(parseStatus(event), 'live');
      });
      current.addEventListener('change', changed);
      current.addEventListener('reset', changed);
      current.addEventListener('error', failed);
      current.addEventListener('readystatechange', (event: Event & { readyState?: number }) => {
        if (event.readyState === 2) failed();
      });
      current.stream();
    } catch {
      if (currentAttempt()) schedule(document.hidden ? 120_000 : 30_000);
    }
  };
  const visibility = () => {
    observe(null, 'http');
    close();
    clearTimeout(refreshTimer);
    refreshTimer = undefined;
    schedule(document.hidden ? 120_000 : 0);
  };
  const pause = () => {
    paused = true;
    identityEpoch++;
    observe(null, 'http');
    close();
    clearTimeout(timer);
    clearTimeout(refreshTimer);
    refreshTimer = undefined;
    nextConnect = undefined;
    void client.cancelQueries({ queryKey: key, exact: true });
    client.removeQueries({ queryKey: key, exact: true });
  };
  const resume = () => {
    if (!stopped && paused) {
      paused = false;
      schedule(0);
    }
  };
  return {
    references: 0,
    admission,
    read,
    start: () => {
      if (started) return;
      started = true;
      document.addEventListener('visibilitychange', visibility);
      window.addEventListener('librechat:auth-session-ending', pause);
      window.addEventListener('librechat:auth-session-continued', resume);
      void connect();
      arm();
    },
    stop: () => {
      if (stopped) return;
      pause();
      stopped = true;
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('librechat:auth-session-ending', pause);
      window.removeEventListener('librechat:auth-session-continued', resume);
    },
  };
}

function ownerFor(client: QueryClient, key: string[]) {
  let owners = ownersByClient.get(client);
  if (!owners) {
    owners = new Map();
    ownersByClient.set(client, owners);
  }
  const identity = JSON.stringify(key);
  let owner = owners.get(identity);
  if (!owner) {
    owner = createOwner(client, key);
    owners.set(identity, owner);
  }
  return owner;
}

/** Hook and reconnect reads must use the same receipt ordering, including failures. */
export const readManagedUploadSnapshot = (
  client: QueryClient,
  key: string[],
  signal?: AbortSignal,
) => ownerFor(client, key).read(signal);

/** Read at the selection boundary after queue waits; a render is not a new observation. */
export const getUploadAdmission = (client: QueryClient, key: string[]) =>
  ownersByClient.get(client)?.get(JSON.stringify(key))?.admission() ?? null;

/** One authenticated stream per identity and tab. Hints trigger a coalesced authoritative read. */
export function acquireUploadLive(client: QueryClient, key: string[]) {
  const owner = ownerFor(client, key);
  if (owner.references++ === 0) owner.start();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--owner.references === 0) {
      owner.stop();
      ownersByClient.get(client)?.delete(JSON.stringify(key));
    }
  };
}
