/** Startup migration checks own their original collection work; shared Mongo remains external. */
const mongoose = require('mongoose');
const {
  logAgentMigrationWarning,
  logPromptMigrationWarning,
  checkAgentPermissionsMigration,
  checkPromptPermissionsMigration,
} = require('@librechat/api');
const { findRoleByIdentifier } = require('~/models');

/** One startup invocation; this is not custody for unrelated database or operator work. */
function createStartupMigrationChecks({ mongoose: source, findRoleByIdentifier: findRole }) {
  let pausedBy = null;
  let stopped = false;
  let active = false;
  let uncertain = false;
  let firstFailure;
  let writes = 0;
  let original;
  const pending = new Set();

  function markUncertain(error) {
    if (!uncertain) firstFailure = error;
    uncertain = true;
  }

  function checkMigrations() {
    if (original) return original;
    if (stopped || pausedBy !== null || uncertain) {
      throw Object.assign(new Error('APP_QUIESCING'), { statusCode: 503 });
    }
    active = true;
    original = Promise.resolve()
      .then(async () => {
        const connection = source.connection;
        const db = connection?.db;
        const client = connection?.getClient();
        const assertCurrent = (expected = db) => {
          if (!active || uncertain) {
            if (!uncertain) markUncertain(new Error('Startup migration original retired'));
            throw firstFailure;
          }
          if (
            !db ||
            !client ||
            expected !== db ||
            source.connection !== connection ||
            connection.db !== db ||
            connection.getClient() !== client
          ) {
            markUncertain(new Error('Startup migration database binding changed'));
            throw firstFailure;
          }
        };
        const retain = (start, write = false, cleanup = false) => {
          if (!active) {
            markUncertain(new Error('Startup migration continuation used after settlement'));
            return Promise.reject(firstFailure);
          }
          if (write) writes++;
          // Install custody before the callback can dispatch its original driver operation.
          const joined = Promise.resolve()
            .then(async () => {
              if (!cleanup) assertCurrent();
              const dispatched = start();
              const value = await dispatched;
              if (!cleanup) assertCurrent();
              return value;
            })
            .catch((error) => {
              markUncertain(error);
              throw error;
            })
            .finally(() => {
              if (write) writes--;
              pending.delete(joined);
            });
          pending.add(joined);
          return joined;
        };
        const observer = Object.freeze({
          assertCurrent,
          track: (start) => retain(start),
          write: (start) => retain(start, true),
          // Cleanup uses the captured cursor even after a failure or connection replacement.
          cleanup: (start) => retain(start, false, true),
          markUncertain,
        });
        assertCurrent();
        const methods = { findRoleByIdentifier: findRole };
        const agents = await observer.track(() =>
          checkAgentPermissionsMigration({
            mongoose: source,
            methods,
            AgentModel: source.models.Agent,
            observer,
          }),
        );
        logAgentMigrationWarning(agents);
        const prompts = await observer.track(() =>
          checkPromptPermissionsMigration({
            mongoose: source,
            methods,
            PromptGroupModel: source.models.PromptGroup,
            observer,
          }),
        );
        logPromptMigrationWarning(prompts);
      })
      .catch((error) => {
        markUncertain(error);
      })
      .then(async () => {
        // Join all retained children before the startup original can finish or reject.
        while (pending.size) await Promise.allSettled([...pending]);
        active = false;
        if (uncertain) throw firstFailure;
      });
    return original;
  }

  return {
    checkMigrations,
    maintenance: {
      pauseAdmissions(requestId) {
        if (
          stopped ||
          typeof requestId !== 'string' ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(requestId) ||
          (pausedBy !== null && pausedBy !== requestId)
        )
          return false;
        pausedBy = requestId;
        return true;
      },
      resumeAdmissions(requestId) {
        if (stopped || uncertain || pausedBy !== requestId) return false;
        pausedBy = null;
        return true;
      },
      async getMaintenanceCensus(requestId) {
        return {
          admissionClosed: stopped || pausedBy !== null,
          queuedContinuations: active ? 1 : 0,
          pendingWrites: writes,
          complete: !uncertain && pausedBy === requestId,
        };
      },
    },
    stopAdmissions() {
      stopped = true;
    },
    async drain() {
      stopped = true;
      await original?.catch(() => undefined);
      if (uncertain) throw firstFailure;
    },
  };
}

const startupMigrationMaintenance = createStartupMigrationChecks({
  mongoose,
  findRoleByIdentifier,
});
module.exports = {
  createStartupMigrationChecks,
  startupMigrationMaintenance,
  checkMigrations: startupMigrationMaintenance.checkMigrations,
};
