const rateLimit = require('express-rate-limit');
const { limiterCache } = require('@librechat/api');

const identifier = (value) => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(value);
const isRead = (req) => req.method === 'GET' || req.method === 'HEAD';

/** Mount both after Workspace authentication and before parsing any document metadata. */
function createWorkspaceLimiters(getPrincipal) {
  if (typeof getPrincipal !== 'function') throw new Error('workspace_principal_required');

  function create(kind, limit) {
    const keys = new WeakMap();
    const limiter = rateLimit({
      windowMs: 60_000,
      limit,
      keyGenerator: (req) => keys.get(req),
      store: limiterCache(`workspace_${kind}_limiter`),
      passOnStoreError: false,
      legacyHeaders: false,
      standardHeaders: 'draft-7',
      handler: (_req, res) => res.status(429).json({ code: 'rate_limited' }),
    });
    return (req, res, next) => {
      if (isRead(req) !== (kind === 'read')) return next();
      try {
        const principal = getPrincipal(req);
        const tenantId = principal?.tenantId;
        const userId = principal?.userId;
        if (!identifier(userId) || (tenantId !== null && !identifier(tenantId)))
          return res.status(401).json({ code: 'unauthorized' });
        // Capture trusted primitive fields before the asynchronous store operation.
        keys.set(req, JSON.stringify([tenantId, userId]));
      } catch {
        return res.status(401).json({ code: 'unauthorized' });
      }
      return limiter(req, res, (error) => {
        keys.delete(req);
        if (error) return res.status(503).json({ code: 'unavailable' });
        return next();
      });
    };
  }

  return { read: create('read', 180), write: create('write', 30) };
}

module.exports = { createWorkspaceLimiters };
