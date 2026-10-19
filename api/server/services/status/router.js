const express = require('express');
const { LIMITS, assertWitness } = require('./cache');

/** Existing auth owners are injected by the ordinary route composition, never role strings. */
function createStatusRouter({
  requireJwtAuth,
  requireCapability,
  hasCapability,
  accessAdmin,
  getSnapshot,
  record = () => {},
}) {
  const router = express.Router();
  router.use(requireJwtAuth);
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.get('/access', async (req, res) => {
    try {
      const id = req.user?.id ?? req.user?._id?.toString();
      const allowed =
        !!id &&
        (await hasCapability(
          {
            id,
            role: req.user?.role ?? '',
            tenantId: req.user?.tenantId,
            idOnTheSource: req.user?.idOnTheSource ?? null,
          },
          accessAdmin,
          { platformOnly: true },
        ));
      if (!res.destroyed) res.json({ allowed });
    } catch {
      if (!res.destroyed) res.status(503).json({ code: 'STATUS_ACCESS_UNAVAILABLE' });
    }
  });
  router.get('/', requireCapability(accessAdmin, { platformOnly: true }), async (req, res) => {
    const controller = new AbortController();
    const abort = () => controller.abort(new Error('STATUS_CLIENT_CLOSED'));
    req.once('aborted', abort);
    res.once('close', abort);
    try {
      if (req.aborted || res.destroyed) abort();
      const snapshot = await getSnapshot(controller.signal);
      const body = snapshot?.body;
      controller.signal.throwIfAborted();
      if (typeof body !== 'string' || Buffer.byteLength(body) > LIMITS.dtoBytes)
        throw Error('STATUS_TOO_LARGE');
      res.type('application/json');
      // Internal deadline metadata is never sent in the sole public DTO.
      assertWitness(snapshot.validUntilMs);
      res.send(body);
    } catch (error) {
      if (!controller.signal.aborted && !res.destroyed) {
        const busy = error?.code === 'STATUS_BUSY';
        if (busy) res.set('Retry-After', '30');
        res.status(busy ? 429 : 503).json({ code: busy ? 'STATUS_BUSY' : 'STATUS_UNAVAILABLE' });
      }
      record('request', controller.signal.aborted ? 'aborted' : 'failure', 0);
    } finally {
      req.off('aborted', abort);
      res.off('close', abort);
    }
  });
  return router;
}
module.exports = { createStatusRouter };
