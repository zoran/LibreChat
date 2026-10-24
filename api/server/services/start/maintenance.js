/** Web maintenance composition within startup; existing domain owners retain their work. */
const {
  createAppMaintenance,
  getOrdinaryS3Provider,
  initializeMaintenanceGeneration,
  probeMaintenanceRedis,
  probeMaintenanceDatabase,
  cacheConfig,
  keyvRedisClient,
  ioredisClient,
  createStreamServices,
  fileDeletionWorkOwner,
  codeEnvironmentLifecycleMaintenance,
  getRemainingShutdownMs,
  createAgentEventTerminalHandler,
  registerShutdownTask,
  GenerationJobManager,
  isEnabled,
} = require('@librechat/api');

/** Preserve the fixed admission/settlement order before startup acquires later resources. */
function registerWebMaintenanceShutdown({
  fileLibraryMaintenance,
  historyMaintenance,
  legacyAuthMaintenance,
  permissionMaintenance,
  mongoCacheMaintenance,
  startupMigrationMaintenance,
  mcpCatalogMaintenance,
}) {
  registerShutdownTask('file deletion admission', () => fileDeletionWorkOwner.stopAdmissions(), {
    phase: 'pre-drain',
    priority: 110,
  });
  registerShutdownTask('file deletion settlement', () => fileDeletionWorkOwner.drain(), {
    phase: 'pre-drain',
    priority: 90,
  });
  registerShutdownTask('file library admission', () => fileLibraryMaintenance.stopAdmissions(), {
    phase: 'pre-drain',
    priority: 110,
  });
  registerShutdownTask('file library settlement', () => fileLibraryMaintenance.drain(), {
    phase: 'pre-drain',
    priority: 90,
  });

  registerShutdownTask('history admission', () => historyMaintenance.stopAdmissions(), {
    phase: 'pre-drain',
    priority: 110,
  });
  registerShutdownTask('history settlement', () => historyMaintenance.drain(), {
    phase: 'pre-drain',
    priority: 90,
  });

  registerShutdownTask('authentication admission', () => legacyAuthMaintenance.stopAdmissions(), {
    phase: 'pre-drain',
    priority: 110,
  });
  registerShutdownTask('authentication settlement', () => legacyAuthMaintenance.drain(), {
    phase: 'pre-drain',
    priority: 90,
  });

  registerShutdownTask(
    'code lifecycle admission',
    () => codeEnvironmentLifecycleMaintenance.stopAdmissions(),
    {
      phase: 'pre-drain',
      priority: 110,
    },
  );
  registerShutdownTask(
    'code lifecycle settlement',
    () => codeEnvironmentLifecycleMaintenance.drain(),
    {
      phase: 'pre-drain',
      priority: 90,
    },
  );
  registerShutdownTask('permission admission', () => permissionMaintenance.stopAdmissions(), {
    phase: 'pre-drain',
    priority: 110,
  });
  registerShutdownTask('permission settlement', () => permissionMaintenance.drain(), {
    phase: 'pre-drain',
    priority: 90,
  });
  registerShutdownTask('Mongo cache admission', () => mongoCacheMaintenance.stopAdmissions(), {
    phase: 'pre-drain',
    priority: 110,
  });
  registerShutdownTask('Mongo cache settlement', () => mongoCacheMaintenance.drain(), {
    phase: 'pre-drain',
    priority: 90,
  });
  registerShutdownTask(
    'startup collection admission',
    () => startupMigrationMaintenance.stopAdmissions(),
    { phase: 'pre-drain', priority: 110 },
  );
  registerShutdownTask('startup collection settlement', () => startupMigrationMaintenance.drain(), {
    phase: 'pre-drain',
    priority: 90,
  });
  registerShutdownTask('MCP catalog admission', () => mcpCatalogMaintenance.stopAdmissions(), {
    phase: 'pre-drain',
    priority: 110,
  });
  registerShutdownTask('MCP catalog settlement', () => mcpCatalogMaintenance.drain(), {
    phase: 'pre-drain',
    priority: 90,
  });
  // The existing retry service registers its own admission/settlement pair exactly once.
}

/** Assemble one App maintenance port; Generation retains that identity and its own census. */
function createWebMaintenance({
  mongoose,
  databaseBootstrap,
  browserMaintenance,
  scheduleMaintenance,
  agentTriggerMaintenance,
  agentQueuedTurnMaintenance,
  skillSyncMaintenance,
  fileLibraryMaintenance,
  uploadMaintenance,
  legacyAuthMaintenance,
  historyMaintenance,
  permissionMaintenance,
  mcpAuthorizationFenceRetryMaintenance,
  mongoCacheMaintenance,
  startupMigrationMaintenance,
  mcpCatalogMaintenance,
  startupReady,
  startupSignal,
  shutdownTeardownReserveMs,
  agentEventMethods,
  recordExpiredScheduleApproval,
  resumeAgentEventDetachedAction,
}) {
  const maintenance = createAppMaintenance({
    startupAdmission: 'closed',
    readStorageProviders: () => ({
      ordinaryS3: getOrdinaryS3Provider(),
      managedS3: uploadMaintenance.readStorageProvider(),
    }),
    workOwners: {
      browser: {
        pauseAdmissions: (id) => browserMaintenance.pauseAdmissions(id),
        resumeAdmissions: (id) => browserMaintenance.resumeAdmissions(id),
        getMaintenanceCensus: (id) => browserMaintenance.getMaintenanceCensus(id),
      },
      schedules: scheduleMaintenance,
      triggers: agentTriggerMaintenance,
      queuedTurns: agentQueuedTurnMaintenance,
      skillSync: skillSyncMaintenance,
      fileDeletion: fileDeletionWorkOwner.maintenance,
      fileLibrary: fileLibraryMaintenance,
      uploads: uploadMaintenance,
      databaseBootstrap,
      auth: legacyAuthMaintenance,
      history: historyMaintenance,
      codeLifecycle: codeEnvironmentLifecycleMaintenance,
      permissions: permissionMaintenance,
      mcpAuthorizationRetry: mcpAuthorizationFenceRetryMaintenance,
      mongoCache: mongoCacheMaintenance.maintenance,
      startupCollections: startupMigrationMaintenance.maintenance,
      mcpCatalog: mcpCatalogMaintenance,
    },
    // Same registered ports; no second admission gate or process identity.
    fileDomainOwners: [
      'browser',
      'schedules',
      'triggers',
      'queuedTurns',
      'skillSync',
      'fileDeletion',
      'fileLibrary',
      'uploads',
      'databaseBootstrap',
      'history',
      'startupCollections',
    ],
    // These actual owners do not yet expose a qualified admission/settlement census.
    unqualifiedOwners: [
      'raw database commands, sessions and independent writers outside qualified owners',
      'standalone tag/share and other HTTP mutations',
      'MCP/OAuth reconnect, search indexing, code lifecycle and remaining background owners',
    ],
    env: process.env,
    requiredSharedState: cacheConfig.SHARED_STATE?.mode === 'sentinel',
    startupReady,
    probeDatabase: () => probeMaintenanceDatabase(mongoose.connection.db.admin()),
    probeSharedState: () =>
      probeMaintenanceRedis({
        required: cacheConfig.USE_REDIS,
        cache: keyvRedisClient,
        commands: ioredisClient,
      }),
    generation: {
      closeGenerationAdmission: (requestId) =>
        GenerationJobManager.closeGenerationAdmission(requestId),
      reopenGenerationAdmission: (requestId) =>
        GenerationJobManager.reopenGenerationAdmission(requestId),
      getGenerationAdmissionCensus: () => GenerationJobManager.getGenerationAdmissionCensus(),
      getGenerationRuntimeHealth: () => GenerationJobManager.getGenerationRuntimeHealth(),
    },
  });

  const configureGenerationStreams = async () => {
    await initializeMaintenanceGeneration({
      required: cacheConfig.SHARED_STATE?.mode === 'sentinel',
      methods: agentEventMethods,
      identity: maintenance.identity,
      configure: (options) => GenerationJobManager.configureGenerationAdmission(options),
    });
    startupSignal.throwIfAborted();
    const streamServices = createStreamServices();
    GenerationJobManager.configure({
      ...streamServices,
      cleanupOnComplete: !isEnabled(process.env.STREAM_KEEP_COMPLETED_JOBS),
    });
    GenerationJobManager.setApprovalExpiredHandler(recordExpiredScheduleApproval);
    GenerationJobManager.setTerminalHostActionHandler(
      createAgentEventTerminalHandler(agentEventMethods, {
        resumeDetachedAction: resumeAgentEventDetachedAction,
      }),
    );
    GenerationJobManager.initialize();
    // Stop active generations and close their SSE streams while the HTTP server drains.
    registerShutdownTask(
      'generation job manager prepare',
      () => GenerationJobManager.prepareForShutdown(),
      {
        phase: 'pre-drain',
        priority: 100,
      },
    );
    /** Join original generation finalization and drain before shared resources may close. */
    registerShutdownTask(
      'generation job manager settlement',
      () => {
        const remaining = getRemainingShutdownMs();
        return GenerationJobManager.awaitGenerationSettlements(
          Math.max(0, (remaining ?? 0) - shutdownTeardownReserveMs),
        );
      },
      { phase: 'pre-drain', priority: 90 },
    );
    // Destruction observes the retained successful pre-drain result; it issues no new finalization.
    registerShutdownTask('generation job manager', () => GenerationJobManager.destroy(), {
      priority: 100,
    });
  };

  return { maintenance, configureGenerationStreams };
}

module.exports = { registerWebMaintenanceShutdown, createWebMaintenance };
