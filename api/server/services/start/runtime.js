/** Ordered application runtime startup before route construction; existing owners retain shutdown. */
const axios = require('axios');
const { runAsSystem, logger } = require('@librechat/data-schemas');
const {
  performStartupChecks,
  initializeFileStorage,
  initializeDeploymentSkills,
  initializeDeploymentPlugins,
  getDeploymentPluginSkills,
  getDeploymentPluginHookCapabilities,
  registerDeploymentPluginHooks,
  hasDeploymentPluginHooks,
  hasDeploymentPluginToolApprovalHooks,
  setPluginHookSource,
  loadToolApprovalHooks,
  registerShutdownTask,
  getRemainingShutdownMs,
  registerBackgroundTaskShutdown,
  updateInterfacePermissions,
  configureAgentEventRuntime,
  warnOnUnreachableDeliveryPaths,
  loadManagedFileDeploymentConfiguration,
} = require('@librechat/api');
const { connectDb, indexSync, modelBootstrap } = require('~/db');
const {
  updateAccessPermissions,
  sweepOrphanedPreviews,
  getRoleByName,
  seedDatabase,
} = require('~/models');
const { initializeGitHubSkillSync } = require('../Skills/sync');
const { initializeUploads } = require('../Uploads');
const { fileLibraryMaintenance } = require('../Files/LibraryMaintenance');
const { configureSubagentTaskRouting } = require('../Endpoints/agents/subagentThreadStore');
const { getAppConfig } = require('../Config');
async function initializeApplicationRuntime({
  registry,
  identity,
  recordOriginalPublication,
  projectRoot,
  shutdownTeardownReserveMs,
  signal,
  onFailure,
}) {
  signal.throwIfAborted();
  const selected = {
    imageDigest: process.env.CORTEX_RETRIEVAL_EXPECTED_IMAGE_DIGEST,
    namespaceUid: process.env.CORTEX_RETRIEVAL_EXPECTED_NAMESPACE_UID,
    configurationSha256: process.env.CORTEX_RETRIEVAL_EXPECTED_CONFIGURATION_SHA256,
  };
  const expected = Object.values(selected).every((value) => value === undefined)
    ? undefined
    : { sourceRevision: identity?.source, ...selected };
  if (expected && expected.sourceRevision !== process.env.BUILD_COMMIT)
    throw new Error('Managed retrieval configuration unavailable');
  const trustedFile = await loadManagedFileDeploymentConfiguration({
    expected,
    signal,
    mode: 'optional',
    onFailure,
  });
  signal.throwIfAborted();
  const appConfig = await getAppConfig({ baseOnly: true });
  signal.throwIfAborted();
  let uploadsOriginal;
  registerShutdownTask(
    'managed upload workers',
    async () => {
      const uploads = await uploadsOriginal;
      if (uploads)
        await uploads.close(
          AbortSignal.timeout(Math.max(1, getRemainingShutdownMs() - shutdownTeardownReserveMs)),
        );
    },
    { priority: 105 },
  );
  // Register custody before starting the original; a late owner stays reachable during shutdown.
  uploadsOriginal = Promise.resolve()
    .then(() => {
      signal.throwIfAborted();
      return initializeUploads({
        registry,
        identity,
        trustedFile,
        recordOriginalPublication,
        signal,
        onFailure,
      });
    })
    .finally(() => modelBootstrap.capture());
  const uploads = await uploadsOriginal;
  signal.throwIfAborted();
  let starting;
  return {
    appConfig,
    uploads,
    // Creation does not dispatch this continuation; the existing web owner waits for exact B.
    start() {
      starting ??= Promise.resolve().then(async () => {
        signal.throwIfAborted();
        await runAsSystem(seedDatabase);
        signal.throwIfAborted();
        // The post-release File original remains visible if a later native hold begins here.
        await fileLibraryMaintenance.run(() => runAsSystem(sweepOrphanedPreviews));
        signal.throwIfAborted();
        await configureSubagentTaskRouting(appConfig?.endpoints?.agents?.subagentActivity);
        signal.throwIfAborted();
        registerBackgroundTaskShutdown({
          interruptGraceMs: appConfig?.endpoints?.agents?.backgroundTasks?.shutdownInterruptGraceMs,
        });
        configureAgentEventRuntime(appConfig?.endpoints?.agents?.eventDriven);
        warnOnUnreachableDeliveryPaths(appConfig);
        initializeFileStorage(appConfig);
        // Plugin hooks execute only when the operator opts in via DEPLOYMENT_PLUGIN_HOOKS;
        // without it, declared hook documents load as parsed-but-inert with a warning.
        await initializeDeploymentPlugins({
          projectRoot,
          hookCapabilities: getDeploymentPluginHookCapabilities(),
        });
        signal.throwIfAborted();
        // Hand the run seam its plugin-hook source without a packages/api-internal
        // agents -> plugins import (see agents/hooks/source.ts).
        setPluginHookSource({
          hasHooks: hasDeploymentPluginHooks,
          hasToolApprovalHooks: hasDeploymentPluginToolApprovalHooks,
          register: registerDeploymentPluginHooks,
        });
        await initializeDeploymentSkills({
          projectRoot,
          additionalSkills: getDeploymentPluginSkills(),
        });
        signal.throwIfAborted();
        initializeGitHubSkillSync(appConfig);
        // Register any programmatic tool-approval policy hooks declared in
        // `endpoints.agents.toolApproval.hooks`. Honor the `enabled` kill switch: when tool
        // approval is off we pass no hooks, so a disabled endpoint imports/runs nothing (and any
        // previously loaded batch is unregistered). Hooks are read from the BASE config only —
        // they register once, process-wide; per-user/tenant differences belong inside the hook
        // (via its context), not in per-override module lists.
        const toolApproval = appConfig?.endpoints?.agents?.toolApproval;
        await loadToolApprovalHooks(toolApproval?.enabled ? toolApproval.hooks : undefined, {
          basePath: projectRoot,
        });
        signal.throwIfAborted();
        await runAsSystem(async () => {
          await performStartupChecks(appConfig);
          signal.throwIfAborted();
          await updateInterfacePermissions({ appConfig, getRoleByName, updateAccessPermissions });
        });
        signal.throwIfAborted();
      });
      return starting;
    },
  };
}
const { initializeStatusUsage } = require('../status/usage');
const { startCodeEnvironmentLifecycleReconciler } = require('@librechat/api');

/** Preserve the connection startup order before Express setup and database seeding. */
async function initializeConnectedRuntime({ mongoose, identity }) {
  if (typeof Bun !== 'undefined') {
    axios.defaults.headers.common['Accept-Encoding'] = 'gzip';
  }
  await connectDb();
  const statusUsage = await initializeStatusUsage({ mongoose, identity });

  logger.info('Connected to MongoDB');
  let starting;
  return {
    statusUsage,
    // The existing web startup calls this only after all preparation, including generation owners.
    completeBootstrap: () => modelBootstrap.seal(),
    // Join the first reconciliation before launching the original index operation.
    start() {
      starting ??= Promise.resolve().then(async () => {
        await startCodeEnvironmentLifecycleReconciler({ mongoose });
        await indexSync();
      });
      return starting;
    },
  };
}
module.exports = { initializeApplicationRuntime, initializeConnectedRuntime };
