/** Configured usage reads, transactional original publication and fenced retention lifecycle. */
const {
  createStatusUsageMethods,
  createStatusUsageCurrentMethods,
  logger,
} = require('@librechat/data-schemas');
const { createUnknownStatusUsage, STATUS_LIMITS } = require('librechat-data-provider');

const SCOPE_ID = 'cortex.application.usage.v1';
const SOURCE_ID = 'application-usage';
const READ_MS = 4000;
const MAX_AGE_SECONDS = 90;
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const unknown = (asOfMs) => ({
  usage: createUnknownStatusUsage(asOfMs / 1000),
  source: null,
  validUntil: null,
});

function observed(group, at, values, complete = false) {
  Object.assign(group, {
    quality: complete ? 'complete' : 'partial',
    reason: complete ? 'observed' : 'partial_coverage',
    observedAt: at,
    values: { ...group.values, ...values },
    coverage:
      group.coverage.basis === 'scheduled_seconds'
        ? { ...group.coverage, expected: 3600, observed: 0 }
        : { ...group.coverage, expected: 1, observed: 1 },
  });
}

function mapEvidence(asOfMs, results) {
  const result = unknown(asOfMs);
  const at = asOfMs / 1000;
  const { usage } = result;
  const value = (i) => (results[i].status === 'fulfilled' ? results[i].value : null);
  for (const [index, group, key] of [
    [0, usage.current.grants, 'signedInUsers'],
    [1, usage.current.documents, 'retainedUploadedDocuments'],
  ]) {
    const proof = value(index);
    if (
      proof?.queryCompleted === true &&
      proof.gap === null &&
      proof.asOfMs === asOfMs &&
      count(proof.value) &&
      proof.value <= 10000
    ) {
      observed(group, at, { [key]: proof.value }, true);
    }
  }
  const window = (target, evidence) => {
    if (
      !evidence ||
      evidence.startMs !== target.start * 1000 ||
      evidence.endMs !== target.end * 1000 ||
      evidence.complete !== false
    )
      return;
    // These are observed subtotals, never an assertion that all hooks or seconds were covered.
    if (['not_instrumented', 'purged_activity'].includes(evidence.gap)) {
      if (evidence.gap !== 'purged_activity' && count(evidence.activeUsers))
        observed(target.groups.users, at, { active: evidence.activeUsers });
      if (count(evidence.publishedDocuments))
        observed(target.groups.documents, at, { published: evidence.publishedDocuments });
    }
  };
  window(usage.lastHour, value(2));
  const history = value(3);
  if (Array.isArray(history) && history.length === 168)
    usage.history.rows.forEach((row, i) => window(row, history[i]));
  const windows = [usage.lastHour, ...usage.history.rows];
  const hasEvidence = [
    usage.current.grants,
    usage.current.documents,
    ...windows.flatMap((row) => [row.groups.users, row.groups.documents]),
  ].some((group) => ['complete', 'partial'].includes(group.quality));
  if (!hasEvidence) return result;
  // The compact wire shares these descriptors across current and every window.
  for (const group of [
    usage.current.grants,
    usage.current.presence,
    usage.current.documents,
    ...windows.flatMap((row) => [row.groups.users, row.groups.documents]),
  ]) {
    group.sourceId = SOURCE_ID;
    group.maxAgeSeconds = MAX_AGE_SECONDS;
  }
  result.source = {
    id: SOURCE_ID,
    kind: 'application_usage',
    observerId: 'cortex-application',
    capturedAt: at,
  };
  result.validUntil = at + MAX_AGE_SECONDS;
  return result;
}

/** All original reads remain owned until settlement; abort is not database cancellation. */
function createUsageRuntime({
  mongoose,
  policy,
  shutdownSignal,
  createStore = createStatusUsageMethods,
  createCurrent = createStatusUsageCurrentMethods,
  monotonic = () => performance.now(),
  collectorId,
  schedule = setTimeout,
  cancel = clearTimeout,
}) {
  // The current factory validates the complete trusted policy before durable model construction.
  const current = createCurrent(mongoose, policy);
  const store = createStore(mongoose, { scopeId: SCOPE_ID, tenantId: policy.tenantId });
  let ready = false;
  let closed = false;
  let pending = null;
  let collector = null;
  let timer = null;
  // One original cycle remains owned through settlement. Losing the lease is not a retry loop.
  function collect() {
    if (closed || shutdownSignal?.aborted || collector || !collectorId) return;
    const original = (async () => {
      const fence = await store.acquireCollector(collectorId);
      if (fence && !closed && !shutdownSignal?.aborted) await store.advanceRetention(fence);
    })();
    collector = original
      .catch(() => {
        // Fixed diagnostic only: driver errors can contain private query/connection details.
        logger.warn('[StatusUsage] Retention cycle failed; coverage remains incomplete');
      })
      .finally(() => {
        collector = null;
        if (!closed && !shutdownSignal?.aborted) {
          timer = schedule(() => {
            timer = null;
            collect();
          }, 30000);
          timer?.unref?.();
        }
      });
  }
  return {
    async initialize() {
      await store.initialize();
      ready = true;
      collect();
    },
    async read({ asOfMs, signal }) {
      if (!Number.isSafeInteger(asOfMs) || asOfMs < 3600000 || asOfMs % 1000 !== 0)
        throw Error('STATUS_USAGE_CAPTURE_INVALID');
      if (!ready || closed || pending || signal?.aborted || shutdownSignal?.aborted)
        return unknown(asOfMs);
      const started = monotonic();
      const reads = [
        () => current.readCurrentAccounts(asOfMs),
        () => current.readCurrentOriginalDocuments(asOfMs),
        () => store.readTrailingHour(asOfMs),
        () => store.readCompletedHours(asOfMs),
      ].map((read) => Promise.resolve().then(read));
      const original = Promise.allSettled(reads);
      pending = original;
      try {
        const results = await original;
        if (
          closed ||
          signal?.aborted ||
          shutdownSignal?.aborted ||
          monotonic() - started >= READ_MS
        )
          return unknown(asOfMs);
        return mapEvidence(asOfMs, results);
      } finally {
        if (pending === original) pending = null;
      }
    },
    async recordOriginalPublication(input, session) {
      if (!ready) throw Error('STATUS_USAGE_NOT_READY');
      if (input.tenantId !== policy.tenantId) return;
      // Uploads owns admission and transaction drain. Pre-drain closes only observation work.
      await store.recordOriginalPublication(input, session);
    },
    async close() {
      closed = true;
      if (timer !== null) {
        cancel(timer);
        timer = null;
      }
      await Promise.allSettled([pending, collector].filter(Boolean));
    },
  };
}

let active = null;
let initialization;
async function initializeStatusUsage({
  mongoose,
  identity,
  env = process.env,
  owners = require('@librechat/api'),
  createRuntime = createUsageRuntime,
}) {
  if (initialization) return initialization;
  initialization = (async () => {
    if (
      env.CORTEX_STATUS_ENABLED !== 'true' ||
      !['email_code', 'transition'].includes(owners.getAuthMode())
    )
      return null;
    const settings = owners.getEmailCodeSettings();
    if (
      settings.configured !== true ||
      typeof env.UPLOAD_SECURITY_POLICY_SHA256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(env.UPLOAD_SECURITY_POLICY_SHA256)
    )
      return null;
    if (
      !identity ||
      typeof identity.incarnation !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        identity.incarnation,
      )
    )
      throw Error('STATUS_USAGE_IDENTITY');
    // Select fields explicitly: the auth settings secret is never forwarded or retained.
    const runtime = createRuntime({
      mongoose,
      collectorId: identity?.incarnation,
      policy: {
        configured: true,
        tenantId: settings.tenantId,
        policyVersion: settings.policyVersion,
        domains: settings.domains,
        qualification: settings.qualification,
        uploadSecurityPolicySha256: env.UPLOAD_SECURITY_POLICY_SHA256,
      },
      shutdownSignal: owners.getShutdownSignal(),
    });
    await runtime.initialize();
    active = runtime;
    owners.registerShutdownTask('application usage reads', () => runtime.close(), {
      phase: 'pre-drain',
      priority: 110,
    });
    return runtime;
  })();
  return initialization;
}

function readStatusUsage(input) {
  return active ? active.read(input) : Promise.resolve(unknown(input.asOfMs));
}

/** Preserve every existing source. An exhausted source budget withholds usage evidence. */
function mergeStatusUsage(snapshot, result, asOfMs) {
  snapshot.usage = createUnknownStatusUsage(asOfMs / 1000);
  if (
    !result?.source ||
    !result.usage ||
    snapshot.sources.length >= STATUS_LIMITS.maxSources ||
    snapshot.sources.some((source) => source.id === SOURCE_ID)
  )
    return null;
  snapshot.sources.push(result.source);
  snapshot.usage = result.usage;
  return result.validUntil;
}

module.exports = {
  createUsageRuntime,
  initializeStatusUsage,
  readStatusUsage,
  mergeStatusUsage,
};
