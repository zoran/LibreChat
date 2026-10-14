import { SSE } from 'sse.js';
import { getTokenHeader } from 'librechat-data-provider';
import type { QueryClient } from '@tanstack/react-query';
import { readUploadSnapshot, uploadsUrl } from './api';

type LiveOwner = { references: number; stop: () => void };
const ownersByClient = new WeakMap<QueryClient, Map<string, LiveOwner>>();

/** One authenticated stream per identity and tab. Hints trigger a coalesced authoritative read. */
export function acquireUploadLive(client: QueryClient, key: string[]) {
  let owners = ownersByClient.get(client);
  if (!owners) {
    owners = new Map();
    ownersByClient.set(client, owners);
  }
  const identity = JSON.stringify(key);
  let owner = owners.get(identity);
  if (!owner) {
    let stopped = false;
    let paused = false;
    let generation = 0;
    let stream: SSE | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let nextRefresh = 0;
    let failures = 0;
    const close = () => {
      generation++;
      const old = stream;
      stream = undefined;
      old?.close();
    };
    const refresh = () => {
      nextRefresh = Date.now() + 5_000;
      // QueryClient deduplicates the initial query, reconnect and all panel subscribers.
      return client.fetchQuery(key, ({ signal }) => readUploadSnapshot(signal), {
        staleTime: 0,
        retry: false,
      });
    };
    const hint = () => {
      if (stopped || paused || refreshTimer || document.hidden) return;
      refreshTimer = setTimeout(
        () => {
          refreshTimer = undefined;
          if (!stopped && !paused) void refresh().catch(() => undefined);
        },
        Math.max(0, nextRefresh - Date.now()),
      );
    };
    const schedule = (delay: number) => {
      clearTimeout(timer);
      if (!stopped && !paused) timer = setTimeout(connect, delay);
    };
    const connect = async () => {
      if (stopped || paused) return;
      close();
      const attempt = generation;
      try {
        await refresh();
        if (stopped || paused || generation !== attempt) return;
        if (document.hidden) {
          schedule(120_000);
          return;
        }
        const current = new SSE(`${uploadsUrl}/events`, {
          method: 'GET',
          headers: { Authorization: getTokenHeader() ?? '' },
        });
        stream = current;
        const reconnect = () => {
          if (stopped || paused || generation !== attempt) return;
          close();
          failures++;
          schedule(Math.min(60_000, 15_000 * failures));
        };
        current.addEventListener('open', () => {
          if (generation === attempt) failures = 0;
        });
        current.addEventListener('change', hint);
        current.addEventListener('reset', hint);
        current.addEventListener('error', reconnect);
        current.addEventListener('readystatechange', (event: Event & { readyState?: number }) => {
          if (event.readyState === 2) reconnect();
        });
        current.stream();
      } catch {
        if (!stopped && !paused && generation === attempt)
          schedule(document.hidden ? 120_000 : 30_000);
      }
    };
    const visibility = () => {
      close();
      clearTimeout(refreshTimer);
      refreshTimer = undefined;
      schedule(document.hidden ? 120_000 : 0);
    };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      close();
      clearTimeout(timer);
      clearTimeout(refreshTimer);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('librechat:auth-session-ending', pause);
      window.removeEventListener('librechat:auth-session-continued', resume);
      void client.cancelQueries({ queryKey: key, exact: true });
      client.removeQueries({ queryKey: key, exact: true });
    };
    const pause = () => {
      paused = true;
      close();
      clearTimeout(timer);
      clearTimeout(refreshTimer);
      refreshTimer = undefined;
      void client.cancelQueries({ queryKey: key, exact: true });
      client.removeQueries({ queryKey: key, exact: true });
    };
    const resume = () => {
      if (!stopped && paused) {
        paused = false;
        schedule(0);
      }
    };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('librechat:auth-session-ending', pause);
    window.addEventListener('librechat:auth-session-continued', resume);
    owner = { references: 0, stop };
    owners.set(identity, owner);
    void connect();
  }
  owner.references++;
  return () => {
    if (--owner!.references === 0) {
      owner!.stop();
      owners!.delete(identity);
    }
  };
}
