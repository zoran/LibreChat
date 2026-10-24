/** Standalone service composition. The caller owns admitted configuration and native activation. */
let processOwner;

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * This is a process-local composition boundary, not a configuration loader or activation receipt.
 * All policies must come from their existing admitted owners. No resource is acquired before start.
 */
function createHousekeepingService(configuration) {
  if (
    !record(configuration) ||
    !['env', 'uploadPolicy', 'filePolicy', 'trustedFile', 'checkpointConfig'].every((key) =>
      record(configuration[key]),
    ) ||
    !/^[a-f0-9]{40}$/.test(configuration.sourceId ?? '') ||
    configuration.env.BUILD_COMMIT !== configuration.sourceId ||
    configuration.env.LOG_TO_FILE !== 'false' ||
    !Array.isArray(configuration.allowedDomains) ||
    !configuration.allowedDomains.length ||
    typeof configuration.timezone !== 'string' ||
    !configuration.timezone.length ||
    !['mongo', 'memory'].includes(configuration.checkpointConfig.type)
  ) {
    throw new Error('Housekeeping requires explicit admitted configuration');
  }
  // Upload activation/baseline facts are not service configuration. Retain only selected policies.
  if (
    Object.keys(configuration.uploadPolicy).some(
      (key) =>
        !['securityPolicySha256', 'extractionPolicySha256', 'retrievalInventoryAuthority'].includes(
          key,
        ),
    ) ||
    Object.keys(configuration.filePolicy).some(
      (key) => !['securityPolicySha256', 'extractionPolicySha256'].includes(key),
    )
  ) {
    throw new Error('Housekeeping policy must not supply activation state');
  }
  const { sourceId, timezone } = configuration;
  const env = Object.freeze({ ...configuration.env });
  const allowedDomains = Object.freeze([...configuration.allowedDomains]);
  const uploadPolicy = Object.freeze(JSON.parse(JSON.stringify(configuration.uploadPolicy)));
  const filePolicy = Object.freeze({ ...configuration.filePolicy });
  const checkpointConfig = Object.freeze({ ...configuration.checkpointConfig });
  const trustedFile = JSON.parse(JSON.stringify(configuration.trustedFile));
  const owner = {};
  let startupOriginal;

  function begin() {
    if (process.env.LOG_TO_FILE !== 'false') {
      throw new Error('Housekeeping requires LOG_TO_FILE=false before package imports');
    }
    const api = require('@librechat/api/housekeeping');
    const schemas = require('@librechat/data-schemas');
    const mongoose = require('mongoose');
    const { createOwnedRedisGenerationCleanup } = require('@librechat/api/generation-cleanup');
    const { composeRetentionMailSender } = require('@librechat/api/mail');
    const { createDbConnector } = require('../../db/connect');
    const { readLogo, createOutboundMailDependencies } = require('./OutboundMail');

    api.setupGracefulShutdown(null, {
      timeoutMs: api.HOUSEKEEPING_POLICY.drainMs,
      deferHttpCloseUntilPreDrain: true,
    });
    const signal = api.getShutdownSignal();
    let connector;
    let redis;
    let client;
    let retrieval;
    let acquisitionOriginal;
    let transferred = false;
    let closing;

    const failStartup = () => {
      void api.requestGracefulShutdown('startup_failure').catch(() => undefined);
    };

    // The application's original work settles before this callback. During partial acquisition,
    // pre-drain joins acquisitionOriginal instead. Neither close path ever waits for app.start().
    function close(signal) {
      closing ??= (async () => {
        const results = await Promise.allSettled([
          Promise.resolve().then(() => retrieval?.close(signal)),
          Promise.resolve().then(() => redis?.close()),
          Promise.resolve().then(() => client?.destroy()),
        ]);
        const errors = results.filter((result) => result.status === 'rejected');
        if (errors.length) {
          // Unresolved derivative/transport custody may still need the owned database connection.
          throw new AggregateError(
            errors.map((result) => result.reason),
            'Housekeeping resource custody remains unresolved',
          );
        }
        await connector?.close();
      })();
      return closing;
    }

    api.registerShutdownTask(
      'housekeeping original acquisition',
      async () => {
        await acquisitionOriginal?.catch(() => undefined);
        if (!transferred) await close();
      },
      { phase: 'pre-drain' },
    );

    async function acquireResources() {
      signal.throwIfAborted();
      connector = createDbConnector({
        mongoose,
        env,
        instrumentMongooseQueryMetrics: api.instrumentMongooseQueryMetrics,
        optionalEnabled: api.optionalEnabled,
        logger: schemas.logger,
        onFailure: failStartup,
      });
      await connector.connect();
      signal.throwIfAborted();
      let jobs;
      let uploads;
      let targets;
      connector.modelBootstrap.construct(() => {
        schemas.createModels(mongoose);
        jobs = schemas.createHousekeepingStore(mongoose);
        uploads = schemas.createUploadManagementRepository(mongoose, uploadPolicy);
        targets = schemas.createFileCleanupProgressMethods(mongoose, jobs);
      });
      for (const resource of [jobs, uploads, targets]) {
        signal.throwIfAborted();
        await schemas.runAsSystem(() => resource.initialize());
      }
      signal.throwIfAborted();
      redis = await createOwnedRedisGenerationCleanup(env, signal);
      signal.throwIfAborted();
      client = api.createManagedS3Client(env);
      const storage = api.createManagedS3Storage({ client, bucket: env.AWS_BUCKET_NAME });
      signal.throwIfAborted();
      retrieval = await api.createManagedFilePurge({
        trustedFile,
        operations: (policySnapshot) => {
          return connector.modelBootstrap.construct(() =>
            schemas.createFileRetrievalOperationOwner(mongoose, { policySnapshot }),
          );
        },
        runAsSystem: schemas.runAsSystem,
        signal,
      });
      signal.throwIfAborted();
      const retention = schemas.createFileRetentionMethods(mongoose, filePolicy);
      const entry = schemas.createFileCleanupClaimMethods(mongoose, jobs, retention);
      const lifecycle = schemas.createFileCleanupLifecycleMethods(
        mongoose,
        jobs,
        schemas.createUploadFileCleanupOwner(mongoose),
        retention,
        {
          purgeRetrieval: (who, ids, operationSignal) => retrieval.purge(who, ids, operationSignal),
          purgeCheckpoints: (who, ids) =>
            api.purgeFileSourceCheckpoints(who, ids, checkpointConfig),
          redactFileSourceContent: schemas.createMessageMethods(mongoose).redactFileSourceContent,
        },
      );
      const fileDiscovery = schemas.createFileHousekeepingDiscoveryMethods(mongoose);
      const repository = schemas.createHousekeepingRepository(
        jobs,
        {
          discover: (handler, cursor) =>
            handler === 'upload.cleanup'
              ? uploads.discoverUploadHousekeeping(cursor)
              : fileDiscovery.discover(handler, cursor),
          coverage: (handler, operationSignal, session) =>
            handler === 'upload.cleanup'
              ? uploads.coverageUploadHousekeeping(operationSignal, session)
              : fileDiscovery.coverage(handler, operationSignal, session),
        },
        { sourceId },
      );
      const cleanup = api.createManagedUploadCleanup({ repository: uploads, storage });
      return {
        env,
        repository,
        fileNotice: schemas.createFileNoticePort(mongoose, jobs, { allowedDomains, timezone }),
        fileCleanup: api.createFileCleanupPort({
          entry,
          targets,
          lifecycle,
          generations: redis.port,
          storage,
          storageBudgetMs: 10000,
        }),
        uploadCleanup: {
          step: (claim, operationSignal) =>
            cleanup.reconcileCleanupOperation(claim, operationSignal),
        },
        mailSender: composeRetentionMailSender(env, allowedDomains, {
          readLogo,
          createMailDependencies: createOutboundMailDependencies,
        }),
        close,
      };
    }

    acquisitionOriginal = (async () => {
      let dependencies;
      let failed;
      try {
        dependencies = await acquireResources();
      } catch (error) {
        failed = { error };
        // A failed owner cannot delay the one process deadline behind another model's init.
        failStartup();
      }
      // The shared connector retains the same memoized originals, including partial acquisition.
      let modelFailure;
      try {
        await connector?.modelBootstrap.join();
      } catch (error) {
        modelFailure = { error };
      }
      if (failed) throw failed.error;
      if (modelFailure) throw modelFailure.error;
      return dependencies;
    })();
    const opening = acquisitionOriginal.then((dependencies) => {
      signal.throwIfAborted();
      const application = api.createHousekeepingApplication(dependencies);
      // The actual application installs its original pre-drain before start() returns.
      const original = application.start();
      transferred = true;
      return original.then(() => application);
    });
    return opening.catch((error) => {
      // Notify immediately; joining shutdown here would cycle through acquisition/pre-drain.
      failStartup();
      throw error;
    });
  }

  return Object.freeze({
    start() {
      if (startupOriginal) return startupOriginal;
      if (processOwner && processOwner !== owner) {
        return Promise.reject(new Error('Housekeeping service already owns this process'));
      }
      processOwner = owner;
      startupOriginal = Promise.resolve().then(begin);
      return startupOriginal;
    },
  });
}

module.exports = { createHousekeepingService };
