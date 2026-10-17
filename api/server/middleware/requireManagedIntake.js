/** Cortex closes legacy file-content ingress until it has a managed intake owner. */
const express = require('express');
const { getAuthMode } = require('@librechat/api');

const isCortexFileMode = () => getAuthMode() !== 'default';

function requireManagedIntake(_req, res, next) {
  if (!isCortexFileMode()) return next();
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Connection', 'close');
  return res.status(403).json({ code: 'managed_upload_required' });
}

/** /usage only touches metadata; every other legacy file POST remains closed. */
function rejectUnmanagedFileWrites(req, res, next) {
  if (req.method !== 'POST' || req.path.replace(/\/+$/, '').toLowerCase() === '/usage') {
    return next();
  }
  return requireManagedIntake(req, res, next);
}

/** Mount before general body parsers. Keep paths aligned with the real routers;
 * Express supplies the same case, trailing-slash and parameter semantics here.
 * Route-local guards also protect compositions that mount those routers alone.
 * This closes the named legacy writes, not every document-content consumer. */
function createManagedIntakeIngress() {
  const router = express.Router();
  router.use('/api/files', rejectUnmanagedFileWrites);
  router.post('/api/convos/import', requireManagedIntake);
  router.post('/api/admin/skills/sync/run', requireManagedIntake);
  router.post(
    [
      '/api/skills',
      '/api/skills/import',
      '/api/skills/:id/files',
      '/api/skills/:id/files/*relativePath',
    ],
    requireManagedIntake,
  );
  router.patch(['/api/skills/:id', '/api/agents/v1/skills/:id'], requireManagedIntake);
  router.put('/api/agents/v1/skills/:id/files/*relativePath', requireManagedIntake);
  return router;
}

module.exports = {
  isCortexFileMode,
  requireManagedIntake,
  rejectUnmanagedFileWrites,
  createManagedIntakeIngress,
};
