import { isUploadPrincipal } from 'librechat-data-provider';
import type { UploadPrincipal } from 'librechat-data-provider';
import type { Request, Response } from 'express';
import type { UploadRepository } from './contract';
import { UploadManagementError } from './errors';

export type UploadRequestPrincipal = (request: Request) => Promise<UploadPrincipal>;
export interface UploadLiveOptions {
  repository: Pick<UploadRepository, 'watchChanges'>;
  /** Immutable server configuration, never selected from a request or browser identity. */
  tenantId: string;
  includeGuests?: boolean;
  /** Strong current grant check; this background read must never extend foreground idle life. */
  principal: UploadRequestPrincipal;
  /** Synchronous cached advisory status; this port must perform no I/O or grant authority. */
  admissionStatus(): boolean | null;
  observe?: (event: {
    connections: number;
    outcome: 'connected' | 'changed' | 'reset' | 'heartbeat' | 'closed' | 'rejected';
  }) => void;
}
type Hint = 'change' | 'reset';
type Connection = {
  req: Request;
  res: Response;
  principal: UploadPrincipal;
  key: string;
  closed: boolean;
  pending?: Hint;
  flight?: Promise<void>;
  batch?: ReturnType<typeof setTimeout>;
  heartbeat?: ReturnType<typeof setTimeout>;
  deadline?: ReturnType<typeof setTimeout>;
  close: () => void;
};
const same = (a: UploadPrincipal, b: UploadPrincipal) =>
  isUploadPrincipal(a) &&
  a.authentication === b.authentication &&
  a.tenantId === b.tenantId &&
  a.userId === b.userId;
const keyOf = (owner: { tenantId: string | null; userId: string }) =>
  JSON.stringify([owner.tenantId, owner.userId]);

/** One replica watch and existing heartbeat; frames contain no private ownership or file data. */
export function createUploadLiveHub(options: UploadLiveOptions) {
  const tenantId = options.tenantId;
  if (typeof tenantId !== 'string' || !tenantId || tenantId.length > 128)
    throw new UploadManagementError('unavailable');
  const allowedTenant = (value: string | null) =>
    value === tenantId || (options.includeGuests === true && value === null);
  const connections = new Set<Connection>();
  const counts = new Map<string, number>();
  let unwatch: (() => void) | undefined;
  let watching = false;
  let watchGeneration = 0;
  let restart: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const observe = (
    outcome: Parameters<NonNullable<UploadLiveOptions['observe']>>[0]['outcome'],
  ) => {
    try {
      options.observe?.({ connections: connections.size, outcome });
    } catch {
      /* Telemetry is advisory. */
    }
  };
  function close(connection: Connection, force = false) {
    if (connection.closed) return;
    connection.closed = true;
    if (connection.batch) clearTimeout(connection.batch);
    if (connection.heartbeat) clearTimeout(connection.heartbeat);
    if (connection.deadline) clearTimeout(connection.deadline);
    connection.req.off('aborted', connection.close);
    connection.res.off('close', connection.close);
    connection.res.off('error', connection.close);
    connections.delete(connection);
    const count = (counts.get(connection.key) ?? 1) - 1;
    if (count) counts.set(connection.key, count);
    else counts.delete(connection.key);
    if (force) connection.res.destroy();
    else if (!connection.res.writableEnded && !connection.res.destroyed) connection.res.end();
    observe('closed');
  }
  function heartbeat(connection: Connection) {
    if (connection.closed) return;
    if (connection.heartbeat) clearTimeout(connection.heartbeat);
    connection.heartbeat = setTimeout(() => {
      connection.heartbeat = undefined;
      void flush(connection);
    }, 15_000);
    connection.heartbeat.unref?.();
  }
  function write(connection: Connection, hint?: Hint) {
    if (connection.closed || connection.res.destroyed || connection.res.writableEnded) {
      close(connection);
      return;
    }
    try {
      let admissionsPaused: boolean | null = null;
      try {
        const value = options.admissionStatus();
        if (typeof value === 'boolean') admissionsPaused = value;
      } catch {
        /* An unavailable advisory cache cannot become an open policy. */
      }
      // Busy hints postpone idle heartbeats, so every authenticated write carries status.
      const status = `event: status\ndata: ${JSON.stringify({ admissionsPaused })}\n\n`;
      const frames = (hint ? `event: ${hint}\ndata: {}\n\n` : '') + status;
      if (!connection.res.write(frames)) {
        close(connection, true);
        return;
      }
      observe(hint === 'change' ? 'changed' : (hint ?? 'heartbeat'));
      heartbeat(connection);
    } catch {
      close(connection);
    }
  }
  function queue(connection: Connection, hint: Hint) {
    if (connection.closed) return;
    connection.pending = connection.pending === 'reset' ? 'reset' : hint;
    if (!connection.batch) {
      connection.batch = setTimeout(() => {
        connection.batch = undefined;
        void flush(connection);
      }, 5000);
      connection.batch.unref?.();
    }
  }
  function flush(connection: Connection): Promise<void> {
    if (connection.closed) return Promise.resolve();
    if (connection.flight) return connection.flight;
    const hint = connection.pending;
    connection.pending = undefined;
    connection.flight = (async () => {
      try {
        const principal = await options.principal(connection.req);
        if (!same(principal, connection.principal) || !allowedTenant(principal.tenantId))
          throw new UploadManagementError('unauthorized');
        write(connection, hint);
      } catch {
        close(connection);
      }
    })().finally(() => {
      connection.flight = undefined;
      if (connection.pending && !connection.closed) queue(connection, connection.pending);
    });
    return connection.flight;
  }
  function watch() {
    if (closed || watching) return;
    watching = true;
    const generation = ++watchGeneration;
    const reset = () => {
      if (closed || generation !== watchGeneration) return;
      watchGeneration++;
      watching = false;
      unwatch?.();
      unwatch = undefined;
      for (const connection of connections) queue(connection, 'reset');
      if (!restart) {
        restart = setTimeout(() => {
          restart = undefined;
          watch();
        }, 5000);
        restart.unref?.();
      }
    };
    try {
      const stop = options.repository.watchChanges({
        tenantId,
        ...(options.includeGuests === true ? { includeGuests: true } : {}),
        onChanged(owner) {
          if (closed || generation !== watchGeneration || !allowedTenant(owner.tenantId)) return;
          const key = keyOf(owner);
          for (const connection of connections)
            if (connection.key === key) queue(connection, 'change');
        },
        onReset: reset,
      });
      if (closed || generation !== watchGeneration) stop();
      else unwatch = stop;
    } catch {
      reset();
    }
  }
  return {
    async open(req: Request, res: Response, expectedPrincipal: UploadPrincipal): Promise<void> {
      if (closed) throw new UploadManagementError('unavailable');
      const principal = await options.principal(req);
      if (!same(principal, expectedPrincipal) || !allowedTenant(principal.tenantId))
        throw new UploadManagementError('unauthorized');
      if (closed || res.destroyed || res.writableEnded || req.aborted)
        throw new UploadManagementError('unavailable');
      const key = keyOf(principal);
      if (connections.size >= 512 || (counts.get(key) ?? 0) >= 2) {
        observe('rejected');
        throw new UploadManagementError('queue_full');
      }
      const connection: Connection = {
        req,
        res,
        principal: { ...principal },
        key,
        closed: false,
        close: () => close(connection),
      };
      connections.add(connection);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      req.on('aborted', connection.close);
      res.on('close', connection.close);
      res.on('error', connection.close);
      connection.deadline = setTimeout(connection.close, 235_000);
      connection.deadline.unref?.();
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Accel-Buffering', 'no');
      observe('connected');
      write(connection, 'reset');
      watch();
    },
    close(): void {
      if (closed) return;
      closed = true;
      watchGeneration++;
      if (restart) clearTimeout(restart);
      restart = undefined;
      unwatch?.();
      unwatch = undefined;
      watching = false;
      for (const connection of [...connections]) close(connection);
    },
  };
}

export type UploadLiveHub = ReturnType<typeof createUploadLiveHub>;
