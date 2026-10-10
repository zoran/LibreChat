/** Real PermissionService -> public data composition -> auth lifetime; adapters stay in memory. */
jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  ...jest.requireActual('../../../packages/api/src/auth/maintenance.ts'),
  ...jest.requireActual('../../../packages/api/src/auth/sessionMaintenance.ts'),
  isEnabled: (value) => value === 'true',
}));
jest.mock('~/server/services/GraphApiService', () => ({
  entraIdPrincipalFeatureEnabled: () => true,
  getUserEntraGroups: async () => ['existing-group'],
}));
jest.mock('~/models', () => {
  const { createMethods } = jest.requireActual('@librechat/data-schemas');
  const mongoose = jest.requireActual('mongoose');
  const cache = {
    get: async () => undefined,
    set: async () => true,
    delete: jest.fn(async () => true),
    crossProcess: true,
    staleEvictionDelayMs: 3000,
  };
  const database = Object.assign(Object.create(mongoose), {
    models: {
      Group: {
        updateMany: async () => ({ acknowledged: true, modifiedCount: 1, upsertedCount: 0 }),
        find: () => ({ lean: async () => [{ idOnTheSource: 'existing-group' }] }),
      },
    },
  });
  return { ...createMethods(database, { getCache: () => cache }), cache };
});

const { syncUserEntraGroupMemberships } = require('./PermissionService');
const { legacyAuthMaintenance: owner, withAuthRequest } = require('./LegacyAuthMaintenance');
const { cache } = require('~/models');

test('an already completed OAuth membership sync retains the real delayed data-owner writes', async () => {
  jest.useFakeTimers();
  const req = {};
  const res = { end: jest.fn() };
  owner.admissionMiddleware(req, res, () => {});
  const pending = [];
  try {
    await withAuthRequest(req, () =>
      syncUserEntraGroupMemberships(
        {
          _id: 'user',
          idOnTheSource: 'member',
          openidId: 'external',
          tenantId: 'tenant-a',
        },
        'test-token',
      ),
    );
    res.end();
    expect(cache.delete).toHaveBeenCalled();
    owner.pauseAdmissions('drain');
    expect(await owner.getMaintenanceCensus('drain')).toMatchObject({
      queuedContinuations: 1,
      pendingWrites: 0,
      complete: true,
    });
    cache.delete.mockImplementation(
      (key) => new Promise((resolve) => pending.push({ key, resolve })),
    );
    await jest.advanceTimersByTimeAsync(3000);
    expect(pending.length).toBeGreaterThan(0);
    expect((await owner.getMaintenanceCensus('drain')).pendingWrites).toBeGreaterThan(0);
    for (const { resolve } of pending.splice(0)) resolve(true);
    await jest.advanceTimersByTimeAsync(0);
    // Dependent prompt invalidation begins only after the retained member-key deletions.
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.every(({ key }) => key.includes('generation'))).toBe(true);
    expect((await owner.getMaintenanceCensus('drain')).pendingWrites).toBeGreaterThan(0);
    for (const { resolve } of pending.splice(0)) resolve(true);
    await jest.advanceTimersByTimeAsync(0);
    expect(await owner.getMaintenanceCensus('drain')).toEqual({
      admissionClosed: true,
      queuedContinuations: 0,
      pendingWrites: 0,
      complete: true,
    });
  } finally {
    for (const { resolve } of pending) resolve(true);
    jest.useRealTimers();
  }
});
