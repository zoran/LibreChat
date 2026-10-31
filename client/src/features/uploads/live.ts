/** live owns one identity-bound upload stream and independent admission freshness causes. */
import { SSE } from 'sse.js';
import { getTokenHeader, readUploadStorageAvailability } from 'librechat-data-provider';
import type { ManagedUploadSnapshot, UploadStorageAvailability } from 'librechat-data-provider';
import type { QueryClient } from '@tanstack/react-query';
import { readUploadSnapshot, uploadsUrl } from './api';

type LiveOwner = {
  references: number;
  start: () => void;
  stop: () => void;
  read: (signal?: AbortSignal) => Promise<ManagedUploadSnapshot>;
  admission: () => boolean | null;
  storage: (required?: boolean) => UploadStorageAvailability | undefined;
};
type Observation = {
  value: boolean;
  source: 'live' | 'http';
  generation: number;
  expiresAt: number;
  storageAvailability?: UploadStorageAvailability;
};
const ownersByClient = new WeakMap<QueryClient, Map<string, LiveOwner>>();
const storageRequiredByClient = new WeakMap<QueryClient, Set<string>>();

/** Closed public status carries only manual pause and optional safe storage availability. */
type Status = { admissionsPaused: boolean | null; storageAvailability?: UploadStorageAvailability };
function parseStatus(event: Event & { data?: string }): Status | null {
  if (typeof event.data !== 'string' || event.data.length > 512) return null;
  try {
    const value: unknown = JSON.parse(event.data);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    if (
      Object.keys(row).some((key) => !['admissionsPaused', 'storageAvailability'].includes(key)) ||
      typeof row.admissionsPaused !== 'boolean'
    )
      return null;
    return {
      admissionsPaused: row.admissionsPaused,
      ...(Object.hasOwn(row, 'storageAvailability')
        ? {
            storageAvailability: readUploadStorageAvailability(row.storageAvailability) ?? {
              available: false,
              reason: 'storage-unavailable',
            },
          }
        : {}),
    };
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
  const identity = JSON.stringify(key);
  let requiredIdentities = storageRequiredByClient.get(client);
  if (!requiredIdentities) {
    requiredIdentities = new Set();
    storageRequiredByClient.set(client, requiredIdentities);
  }
  let storageRequired = requiredIdentities.has(identity);
  const requireStorage = () => {
    storageRequired = true;
    requiredIdentities.add(identity);
  };
  let stream: SSE | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let nextRefresh = 0;
  let nextConnect: number | undefined;
  let failures = 0;
  const manualPause = () =>
    !stopped &&
    !paused &&
    !document.hidden &&
    observation &&
    performance.now() < observation.expiresAt
      ? observation.value
      : null;
  const storage = (required = false): UploadStorageAvailability | undefined => {
    if (required) requireStorage();
    if (!storageRequired) return undefined;
    if (stopped || paused || document.hidden || !observation)
      return { available: false, reason: 'storage-unavailable' };
    if (performance.now() >= observation.expiresAt)
      return { available: false, reason: 'storage-stale' };
    return observation.storageAvailability ?? { available: false, reason: 'storage-unavailable' };
  };
  // The selection getter closes on either cause, without changing the manual policy bit.
  const admission = () => {
    if (manualPause() === true) return true;
    if (storage()?.available === false) return null;
    return manualPause();
  };
  const patchAdmission = () => {
    const query = client.getQueryCache().find<ManagedUploadSnapshot>(key, { exact: true });
    const data = query?.state.data;
    const admissionsPaused = manualPause();
    const storageAvailability = storage();
    if (
      query &&
      data &&
      (data.admissionsPaused !== admissionsPaused ||
        JSON.stringify(data.storageAvailability) !== JSON.stringify(storageAvailability))
    ) {
      // A heartbeat is not a file refresh: preserve its age, errors and fetch state.
      query.setState({
        data: { ...data, admissionsPaused, ...(storageRequired ? { storageAvailability } : {}) },
      });
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
  const observe = (status: Status | null, source: Observation['source']) => {
    if (status && Object.hasOwn(status, 'storageAvailability')) requireStorage();
    const value = status?.admissionsPaused;
    sequence++;
    observation =
      typeof value === 'boolean' && !document.hidden
        ? {
            value,
            source,
            generation,
            expiresAt: performance.now() + (source === 'live' ? 20_000 : 75_000),
            storageAvailability: status?.storageAvailability,
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
      if (sequence === received)
        observe(
          {
            admissionsPaused: data.admissionsPaused,
            ...(Object.hasOwn(data, 'storageAvailability')
              ? {
                  storageAvailability: readUploadStorageAvailability(data.storageAvailability) ?? {
                    available: false as const,
                    reason: 'storage-unavailable' as const,
                  },
                }
              : {}),
          },
          'http',
        );
      return {
        ...data,
        admissionsPaused: manualPause(),
        ...(storageRequired ? { storageAvailability: storage() } : {}),
      };
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
    storage,
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
  storageRequired = false,
) => {
  const owner = ownerFor(client, key);
  owner.storage(storageRequired);
  return owner.read(signal);
};

/** Read at the selection boundary after queue waits; a render is not a new observation. */
export const getUploadAdmission = (client: QueryClient, key: string[]) =>
  ownersByClient.get(client)?.get(JSON.stringify(key))?.admission() ?? null;

/** One authenticated stream per identity and tab. Hints trigger a coalesced authoritative read. */
export function acquireUploadLive(client: QueryClient, key: string[], storageRequired = false) {
  const owner = ownerFor(client, key);
  owner.storage(storageRequired);
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

/** Current storage lease; once NAS status is observed, absent/reset frames never downgrade it. */
export const getUploadStorageAvailability = (
  client: QueryClient,
  key: string[],
  required = false,
) => ownerFor(client, key).storage(required);

/** Manual policy is independent of automatic storage recovery. */
export const getUploadManualPause = (client: QueryClient, key: string[]) => {
  const state = client.getQueryData<ManagedUploadSnapshot>(key);
  return state?.admissionsPaused ?? null;
};
