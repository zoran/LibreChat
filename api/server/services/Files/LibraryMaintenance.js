/** File-library transaction custody; HTTP closure never settles an admitted Mongo/session promise. */
function createFileLibraryMaintenance() {
  const active = new Set();
  let pausedBy = null;
  let stopped = false;
  let uncertain = false;
  let draining;

  return {
    async run(start) {
      if (stopped || pausedBy !== null) throw new Error('FILE_LIBRARY_QUIESCING');
      // Register before dispatch; adoption retains the original method through endSession().
      const original = Promise.resolve().then(start);
      active.add(original);
      try {
        return await original;
      } catch (error) {
        uncertain = true;
        throw error;
      } finally {
        active.delete(original);
      }
    },
    pauseAdmissions(requestId) {
      if (
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
        queuedContinuations: 0,
        pendingWrites: active.size,
        complete: !uncertain && pausedBy === requestId,
      };
    },
    stopAdmissions() {
      stopped = true;
    },
    drain() {
      stopped = true;
      draining ??= (async () => {
        await Promise.allSettled([...active]);
        if (uncertain) throw new Error('FILE_LIBRARY_SETTLEMENT_UNCONFIRMED');
      })();
      return draining;
    },
  };
}

const fileLibraryMaintenance = createFileLibraryMaintenance();

module.exports = { createFileLibraryMaintenance, fileLibraryMaintenance };
