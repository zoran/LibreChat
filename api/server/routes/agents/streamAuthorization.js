const jwt = require('jsonwebtoken');
const { validateEmailCodeBearer, validateBrowserBearer } = require('@librechat/api');
const { runAsSystem } = require('@librechat/data-schemas');
const models = require('~/models');

/** Per-process transport limits, not a staff/concurrent-generation capacity claim.
 * UTF-8 byte accounting excludes JS object/string and socket representation overhead.
 * The existing bounded replay snapshot can exceed a single ordinary stream event. */
const STREAM_AUTHORIZATION_LIMITS = Object.freeze({
  batchMs: 250,
  idleMs: 15000,
  authorizeMs: 5000,
  drainMs: 5000,
  connections: 128,
  perOwner: 2,
  authFlights: 128,
  frames: 1024,
  frameBytes: 32 * 1024 * 1024,
  connectionBytes: 32 * 1024 * 1024,
  processBytes: 64 * 1024 * 1024,
});

const MAX_BEARER_LENGTH = 16384;

/** Account escaped JSON text before JSON.stringify grows its result. No copied
 * UTF-8 buffer is needed; lone surrogates are emitted as six ASCII characters. */
function stringBytes(value, available) {
  let bytes = Buffer.byteLength(value, 'utf8') + 2;
  if (bytes > available) throw new Error('stream_frame_limit');
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 34 || code === 92) bytes++;
    else if (code < 32) bytes += [8, 9, 10, 12, 13].includes(code) ? 1 : 5;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
      else bytes += 3;
    } else if (code >= 0xdc00 && code <= 0xdfff) bytes += 3;
    if (bytes > available) throw new Error('stream_frame_limit');
  }
  return bytes;
}

/** Conservative punctuation accounting and a finite traversal budget prevent an
 * oversize event from first producing an unbounded serialized string. Circular,
 * BigInt and throwing toJSON values are rejected by this same boundary. */
function boundedJson(value, available) {
  let used = 0;
  let nodes = 0;
  const result = JSON.stringify(value, function (key, item) {
    // Every visited value consumes at least one accounted byte; do not impose
    // a smaller shape limit than the existing replay byte contract.
    if (++nodes > available) throw new Error('stream_frame_limit');
    if (nodes > 1) {
      used++; // At most one comma per child; deliberately conservative for the first.
      if (!Array.isArray(this)) used += stringBytes(key, available - used) + 1;
    }
    if (typeof item === 'string') used += stringBytes(item, available - used);
    else if (item === null) used += 4;
    else if (typeof item === 'number') used += Number.isFinite(item) ? String(item).length : 4;
    else if (typeof item === 'boolean') used += item ? 4 : 5;
    else if (typeof item === 'object') used += 2;
    else if (typeof item === 'bigint') throw new Error('stream_invalid_frame');
    else used += 4;
    if (used > available) throw new Error('stream_frame_limit');
    return item;
  });
  if (result === undefined) throw new Error('stream_invalid_frame');
  return result;
}

function expectedIdentity(req) {
  if (req.authenticationClass === 'guest') {
    const grant = req.browserGrant;
    if (
      !grant ||
      grant.tenantId !== null ||
      typeof grant.sessionId !== 'string' ||
      !/^[a-f0-9]{24}$/.test(grant.sessionId) ||
      typeof grant.userId !== 'string' ||
      !/^[a-f0-9]{24}$/.test(grant.userId) ||
      req.user?.id !== grant.userId ||
      req.user?.provider !== 'browser' ||
      req.user.tenantId != null
    )
      return null;
    return {
      authentication: 'guest',
      sessionId: grant.sessionId,
      userId: grant.userId,
      tenantId: null,
    };
  }
  const grant = req.emailCodeGrant;
  if (
    req.authenticationClass !== 'verified-email' ||
    !grant ||
    typeof grant.sessionId !== 'string' ||
    !grant.sessionId ||
    grant.sessionId.length > 256 ||
    typeof grant.userId !== 'string' ||
    !grant.userId ||
    grant.userId.length > 256 ||
    typeof grant.tenantId !== 'string' ||
    !grant.tenantId ||
    grant.tenantId.length > 256 ||
    !Number.isSafeInteger(grant.authVersion) ||
    grant.authVersion < 0 ||
    !Number.isSafeInteger(grant.policyVersion) ||
    grant.policyVersion < 1 ||
    req.user?.id !== grant.userId ||
    req.user?.tenantId !== grant.tenantId
  )
    return null;
  return {
    authentication: 'verified-email',
    sessionId: grant.sessionId,
    userId: grant.userId,
    tenantId: grant.tenantId,
    authVersion: grant.authVersion,
    policyVersion: grant.policyVersion,
  };
}

function matchesIdentity(identity, expected) {
  return (
    identity?.user?.id === expected.userId &&
    (expected.authentication === 'guest'
      ? identity.user.provider === 'browser' && identity.user.tenantId == null
      : identity.user.tenantId === expected.tenantId) &&
    Object.keys(expected)
      .filter((key) => key !== 'authentication')
      .every((key) => identity.grant?.[key] === expected[key])
  );
}

/** One controller owns the process budget. Tests may create isolated controllers;
 * routes use the single exported binding below. No pending-auth admission queue. */
function createStreamAuthorizationController(limits = STREAM_AUTHORIZATION_LIMITS) {
  let connections = 0;
  let pendingBytes = 0;
  let authFlights = 0;
  const owners = new Map();

  return function createStreamAuthorization({ req, res, write, onClose }) {
    const expected = expectedIdentity(req);
    const owner = expected && JSON.stringify([expected.tenantId, expected.userId]);
    let bearer = req.headers?.authorization;
    let token;
    if (typeof bearer === 'string' && bearer.length <= MAX_BEARER_LENGTH) {
      token = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(bearer)?.[1];
    }
    bearer = undefined;

    let charged = false;
    let closed = false;
    let ending = false;
    let endSent = false;
    let serializing = false;
    let authorizing = false;
    let draining = false;
    let forceRead = false;
    let heldBytes = 0;
    let heldFrames = 0;
    let drainBytes = 0;
    let batchTimer;
    let idleTimer;
    let authTimer;
    let drainTimer;
    let flushPromise;
    let resolveFlush;
    const queue = [];

    const clearTimer = (timer) => {
      if (timer !== undefined) clearTimeout(timer);
    };
    const settleFlush = (ok) => {
      const resolve = resolveFlush;
      resolveFlush = undefined;
      flushPromise = undefined;
      if (resolve) forceRead = false;
      resolve?.(ok);
    };
    const releaseFrame = (bytes) => {
      heldBytes -= bytes;
      pendingBytes -= bytes;
      heldFrames--;
    };

    function close(destroy = true) {
      if (closed) return;
      closed = true;
      ending = true;
      token = undefined;
      for (const timer of [batchTimer, idleTimer, authTimer, drainTimer]) clearTimer(timer);
      batchTimer = idleTimer = authTimer = drainTimer = undefined;
      queue.length = 0;
      pendingBytes -= heldBytes;
      heldBytes = heldFrames = drainBytes = 0;
      if (charged) {
        charged = false;
        connections--;
        const remaining = owners.get(owner) - 1;
        if (remaining === 0) owners.delete(owner);
        else owners.set(owner, remaining);
      }
      req.removeListener('close', handleClose);
      res.removeListener('close', handleClose);
      res.removeListener('error', handleClose);
      res.removeListener('finish', handleFinish);
      res.removeListener('drain', handleDrain);
      settleFlush(false);
      try {
        onClose?.();
      } catch {
        /* Cleanup must not retain transport charges. */
      }
      if (destroy && !res.writableFinished && !res.destroyed) {
        try {
          res.destroy();
        } catch {
          /* Already closed; no private error is disclosed. */
        }
      }
    }

    function handleClose() {
      close();
    }
    function handleFinish() {
      close(false);
    }

    function scheduleIdle() {
      clearTimer(idleTimer);
      if (closed || endSent) return;
      idleTimer = setTimeout(() => {
        idleTimer = undefined;
        forceRead = true;
        void authorize();
      }, limits.idleMs);
      idleTimer.unref?.();
    }

    function scheduleBatch() {
      if (closed || endSent || authorizing || draining || batchTimer !== undefined) return;
      if (queue.length === 0 && !forceRead) return;
      batchTimer = setTimeout(() => {
        batchTimer = undefined;
        void authorize();
      }, limits.batchMs);
      batchTimer.unref?.();
    }

    function completeIfDrained() {
      if (closed || draining || queue.length !== 0) return;
      settleFlush(true);
      if (!ending || endSent) return;
      endSent = true;
      clearTimer(idleTimer);
      clearTimer(batchTimer);
      // Retain the connection charge until finish/close, also when end itself stalls.
      drainTimer = setTimeout(handleClose, limits.drainMs);
      drainTimer.unref?.();
      try {
        res.end();
      } catch {
        close();
      }
    }

    function handleDrain() {
      if (closed || !draining) return;
      draining = false;
      clearTimer(drainTimer);
      drainTimer = undefined;
      releaseFrame(drainBytes);
      drainBytes = 0;
      completeIfDrained();
      // Crossing an asynchronous drain invalidates the remaining authorized batch.
      scheduleBatch();
    }

    async function authorize() {
      if (closed || endSent || authorizing || draining) return;
      if (queue.length === 0 && !forceRead) return;
      clearTimer(batchTimer);
      batchTimer = undefined;
      if (authFlights >= limits.authFlights) {
        close();
        return;
      }
      authorizing = true;
      authFlights++;
      clearTimer(idleTimer);
      idleTimer = undefined;
      const batchLength = queue.length; // Later arrivals require another current read.
      forceRead = false;
      authTimer = setTimeout(handleClose, limits.authorizeMs);
      authTimer.unref?.();
      try {
        const payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
        const identity = await runAsSystem(() =>
          expected.authentication === 'guest'
            ? validateBrowserBearer(payload, req, models)
            : validateEmailCodeBearer(payload, models),
        );
        if (closed) return;
        if (
          !matchesIdentity(identity, expected) ||
          typeof payload.exp !== 'number' ||
          payload.exp * 1000 <= Date.now()
        ) {
          close();
          return;
        }
        clearTimer(authTimer);
        authTimer = undefined;
        scheduleIdle();
        for (let i = 0; i < batchLength; i++) {
          const frame = queue.shift();
          const accepted = write(frame.payload, frame.options);
          if (closed) return;
          if (accepted === false) {
            draining = true;
            drainBytes = frame.bytes;
            drainTimer = setTimeout(handleClose, limits.drainMs);
            drainTimer.unref?.();
            break;
          }
          releaseFrame(frame.bytes);
        }
        completeIfDrained();
      } catch {
        close();
      } finally {
        clearTimer(authTimer);
        authTimer = undefined;
        // A closed response never releases an unsettled DB promise's process slot.
        authFlights--;
        authorizing = false;
        scheduleBatch();
      }
    }

    function enqueue(event, options = {}) {
      if (closed || ending) return false;
      if (serializing || heldFrames >= limits.frames) {
        close();
        return false;
      }
      const eventName = options.eventName ?? 'message';
      if (typeof eventName !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(eventName)) {
        close();
        return false;
      }
      const prefix = `event: ${eventName}\ndata: `;
      const overhead = Buffer.byteLength(prefix) + 2;
      const reservation = Math.min(
        limits.frameBytes,
        limits.connectionBytes - heldBytes,
        limits.processBytes - pendingBytes,
      );
      if (reservation <= overhead) {
        close();
        return false;
      }
      // Reserve before serialization or array growth, then shrink to actual wire bytes.
      heldFrames++;
      heldBytes += reservation;
      pendingBytes += reservation;
      serializing = true;
      try {
        const json = boundedJson(event, reservation - overhead);
        if (closed) return false;
        const payload = `${prefix}${json}\n\n`;
        const bytes = Buffer.byteLength(payload);
        if (bytes > reservation) throw new Error('stream_frame_limit');
        heldBytes -= reservation - bytes;
        pendingBytes -= reservation - bytes;
        queue.push({ payload, bytes, options: { final: options.final === true } });
      } catch {
        close();
        return false;
      } finally {
        serializing = false;
      }
      scheduleBatch();
      return true;
    }

    const output = {
      write: enqueue,
      finish(event, options) {
        if (!enqueue(event, options)) return false;
        ending = true;
        return true;
      },
      flush() {
        if (closed) return Promise.resolve(false);
        if (!flushPromise) {
          flushPromise = new Promise((resolve) => {
            resolveFlush = resolve;
          });
          forceRead = true;
          scheduleBatch();
        }
        return flushPromise;
      },
      close,
      get closed() {
        return closed;
      },
      get ending() {
        return ending;
      },
    };

    if (
      !expected ||
      !token ||
      connections >= limits.connections ||
      (owners.get(owner) ?? 0) >= limits.perOwner ||
      res.writableEnded ||
      res.destroyed
    ) {
      close();
      return output;
    }
    charged = true;
    connections++;
    owners.set(owner, (owners.get(owner) ?? 0) + 1);
    req.once('close', handleClose);
    res.once('close', handleClose);
    res.once('error', handleClose);
    res.once('finish', handleFinish);
    res.on('drain', handleDrain);
    scheduleIdle();
    return output;
  };
}

const createStreamAuthorization = createStreamAuthorizationController();
module.exports = {
  STREAM_AUTHORIZATION_LIMITS,
  createStreamAuthorizationController,
  createStreamAuthorization,
};
