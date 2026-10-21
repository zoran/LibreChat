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
} = require('@librechat/api');
const { connectDb, indexSync } = require('~/db');
const {
  updateAccessPermissions,
  sweepOrphanedPreviews,
  getRoleByName,
  seedDatabase,
} = require('~/models');
const { initializeGitHubSkillSync } = require('../Skills/sync');
const { startExpiredFileSweep } = require('../Files/process');
const { initializeUploads } = require('../Uploads');
const { configureSubagentTaskRouting } = require('../Endpoints/agents/subagentThreadStore');
const { getAppConfig } = require('../Config');
async function initializeApplicationRuntime({
  registry,
  identity,
  recordOriginalPublication,
  projectRoot,
  shutdownTeardownReserveMs,
}) {
  await runAsSystem(seedDatabase);
  /* Recover stuck `status: 'pending'` records from a crash mid-render.
   * `runAsSystem` is required — `File` is tenant-isolated and strict
   * mode rejects unscoped queries. Lazy sweep in the preview endpoint
   * covers anything younger than the boot cutoff. */
  // Complete the only boot sweep before readiness or the maintenance listener.
  // An unknown write outcome prevents startup instead of reporting an idle owner.
  await runAsSystem(sweepOrphanedPreviews);
  const appConfig = await getAppConfig({ baseOnly: true });
  await configureSubagentTaskRouting(appConfig?.endpoints?.agents?.subagentActivity);
  registerBackgroundTaskShutdown({
    interruptGraceMs: appConfig?.endpoints?.agents?.backgroundTasks?.shutdownInterruptGraceMs,
  });
  configureAgentEventRuntime(appConfig?.endpoints?.agents?.eventDriven);
  warnOnUnreachableDeliveryPaths(appConfig);
  initializeFileStorage(appConfig);
  const uploads = await initializeUploads({ registry, identity, recordOriginalPublication });
  if (uploads) {
    registerShutdownTask(
      'managed upload workers',
      () =>
        uploads.close(
          AbortSignal.timeout(Math.max(1, getRemainingShutdownMs() - shutdownTeardownReserveMs)),
        ),
      { priority: 105 },
    );
  }
  // Plugin hooks execute only when the operator opts in via DEPLOYMENT_PLUGIN_HOOKS;
  // without it, declared hook documents load as parsed-but-inert with a warning.
  await initializeDeploymentPlugins({
    projectRoot,
    hookCapabilities: getDeploymentPluginHookCapabilities(),
  });
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
  initializeGitHubSkillSync(appConfig);
  startExpiredFileSweep({ appConfig, loadAppConfig: getAppConfig });
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
  await runAsSystem(async () => {
    await performStartupChecks(appConfig);
    await updateInterfacePermissions({ appConfig, getRoleByName, updateAccessPermissions });
  });

  return { appConfig, uploads };
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
  startCodeEnvironmentLifecycleReconciler({ mongoose });
  indexSync().catch((err) => {
    logger.error('[indexSync] Background sync failed:', err);
  });

  return statusUsage;
}
module.exports = { initializeApplicationRuntime, initializeConnectedRuntime };
