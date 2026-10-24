require('../config/credentials');

const telemetry = require('./telemetry');
const fs = require('fs');
const path = require('path');
require('module-alias')({ base: path.resolve(__dirname, '..') });
const cors = require('cors');
const express = require('express');
const mongoose = require('mongoose');
const passport = require('passport');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const mongoSanitize = require('express-mongo-sanitize');
const { logger, runAsSystem } = require('@librechat/data-schemas');
const {
  isEnabled,
  issueCsp,
  apiNotFound,
  createMetrics,
  applyCspNonce,
  createCspPolicy,
  shellCacheHeaders,
  createPresentation,
  emailCodeLandingHtml,
  ErrorController,
  memoryDiagnostics,
  createSecurityHeaders,
  handleJsonParseError,
  excludeRumBodyParser,
  GenerationJobManager,
  QUERY_DEVTOOLS_HEADER,
  agentStartupIngressMiddleware,
  agentStartupTelemetryMiddleware,
  maybeInjectQueryDevtoolsBootstrap,
  injectConfiguredFooterBootstrap,
  preAuthTenantMiddleware,
  requestContextMiddleware,
  registerShutdownTask,
  configureServerTimeouts,
  setupGracefulShutdown,
  getShutdownSignal,
  requestGracefulShutdown,
  configureMessageFilterRegexValidator,
  configureFileConfigRegexEngine,
  createScheduleWriteGate,
  waitForRedisStartup,
  createCodeApiUploadRegistry,
  mongoCacheMaintenance,
} = require('@librechat/api');
const app = express();
let serverReady = false;
let database;

/** Model consumers run inside the preregistered original web startup. */
async function prepareAndStart() {
  database = require('../db/connect').getDbConnector({ onFailure: failStartup });
  // Register existing Mongoose models before any application method consumer.
  require('~/db');
  const initializeOAuthReconnectManager = require('./services/initializeOAuthReconnectManager');
  const { capabilityContextMiddleware } = require('./middleware/roles/capabilities');
  const { createManagedIntakeIngress } = require('./middleware/requireManagedIntake');
  const createValidateImageRequest = require('./middleware/validateImageRequest');
  const { skillSyncMaintenance } = require('./services/Skills/sync');
  const {
    initializeAgentTriggerService,
    agentTriggerMaintenance,
    agentQueuedTurnMaintenance,
  } = require('./services/Agents/triggers');
  const { resumeAgentEventDetachedAction } = require('./services/Agents/detachedActionResume');
  const {
    initializeScheduleEngine,
    recordExpiredScheduleApproval,
    scheduleMaintenance,
  } = require('./services/Schedules');
  const {
    legacyAuthMaintenance,
    getBrowserAuth,
    authAdmissionMiddleware,
    installAuthPassport,
  } = require('./services/LegacyAuthMaintenance');
  installAuthPassport(passport);
  const { jwtLogin, ldapLogin, passportLogin } = require('~/strategies');
  const { checkMigrations, startupMigrationMaintenance } = require('./services/start/migration');
  const optionalJwtAuth = require('./middleware/optionalJwtAuth');
  const requireJwtAuth = require('./middleware/requireJwtAuth');
  const { uploadMaintenance } = require('./services/Uploads');
  const { fileLibraryMaintenance } = require('./services/Files/LibraryMaintenance');
  const { historyMaintenance } = require('./services/HistoryMaintenance');
  const { permissionMaintenance } = require('./services/PermissionMaintenance');
  const {
    mcpAuthorizationFenceRetryMaintenance,
  } = require('./services/MCPAuthorizationFenceRetry');
  const {
    initializeApplicationRuntime,
    initializeConnectedRuntime,
  } = require('./services/start/runtime');
  const {
    registerWebMaintenanceShutdown,
    createWebMaintenance,
  } = require('./services/start/maintenance');
  const initializeMCPs = require('./services/initializeMCPs');
  const {
    mcpCatalogMaintenance,
    runMCPToolPublication,
  } = require('./services/Config/getCachedTools');
  const configureSocialLogins = require('./socialLogins');
  const createSpaFallback = require('./utils/fallback');
  const staticCache = require('./utils/staticCache');
  const noIndex = require('./middleware/noIndex');
  const agentEventMethods = require('~/models');

  /** Route admin file-config MIME patterns through a linear-time engine (ReDoS-safe) on upload. */
  configureFileConfigRegexEngine();

  /** Reject messageFilter PII patterns the RE2 runtime engine cannot compile, at config load. */
  configureMessageFilterRegexValidator();

  const { PORT, HOST, ALLOW_SOCIAL_LOGIN, DISABLE_COMPRESSION, TRUST_PROXY } = process.env ?? {};

  // Allow PORT=0 to be used for automatic free port assignment
  const port = isNaN(Number(PORT)) ? 3080 : Number(PORT);
  const host = HOST || 'localhost';
  const trusted_proxy = Number(TRUST_PROXY) || 1; /* trust first proxy by default */

  registerWebMaintenanceShutdown({
    fileLibraryMaintenance,
    historyMaintenance,
    legacyAuthMaintenance,
    permissionMaintenance,
    mongoCacheMaintenance,
    startupMigrationMaintenance,
    mcpCatalogMaintenance,
  });

  app.locals.codeApiUploadRegistry = createCodeApiUploadRegistry();
  /** @type {import('@librechat/api').ScheduleEngineState} */
  let scheduleEngineState = 'starting';

  const CHAT_START_RETRY_AFTER_SECONDS = '1';
  const browserMaintenance = getBrowserAuth();
  /** Reserve time for existing teardown after generation settlement. */
  const SHUTDOWN_TEARDOWN_RESERVE_MS = 10_000;
  const rejectScheduleWritesUntilReady = createScheduleWriteGate({
    getState: () => scheduleEngineState,
    retryAfterSeconds: CHAT_START_RETRY_AFTER_SECONDS,
  });

  const startServer = async () => {
    // This finite original is admitted before App construction pauses its owners.
    // Its settlement precedes both listeners and B; post-release work gets fresh roots.
    const {
      maintenance,
      metricsMiddleware,
      metricsRouter,
      connected,
      application,
      appConfig,
      uploads,
    } = await runMCPToolPublication(async () => {
      const { maintenance, configureGenerationStreams } = createWebMaintenance({
        mongoose,
        databaseBootstrap: database.modelBootstrap.maintenance,
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
        startupReady: () => serverReady,
        startupSignal,
        shutdownTeardownReserveMs: SHUTDOWN_TEARDOWN_RESERVE_MS,
        agentEventMethods,
        recordExpiredScheduleApproval,
        resumeAgentEventDetachedAction,
      });
      startupSignal.throwIfAborted();
      await waitForRedisStartup();
      startupSignal.throwIfAborted();
      const { metricsMiddleware, metricsRouter, registry } = createMetrics({
        collectAgentEventActorStorageMetrics: () =>
          runAsSystem(async () => {
            const now = new Date();
            const [receiptMetrics, reconciliationMetrics] = await Promise.all([
              agentEventMethods.getAgentEventActorReceiptStorageMetrics(now),
              agentEventMethods.getAgentEventActorReconciliationStorageMetrics(now),
            ]);
            return {
              ...receiptMetrics,
              pendingReconciliations: reconciliationMetrics.pending,
              oldestPendingAgeSeconds: reconciliationMetrics.oldestPendingAgeSeconds,
            };
          }),
      });
      if (!process.env.METRICS_SECRET) {
        logger.warn(
          '[metrics] METRICS_SECRET is not set - /metrics will return 401 for all requests',
        );
      }

      const connected = await initializeConnectedRuntime({
        mongoose,
        identity: maintenance.identity,
      });
      startupSignal.throwIfAborted();

      app.disable('x-powered-by');
      app.set('trust proxy', trusted_proxy);

      /* Registered ahead of every route so health checks carry the headers too. */
      const securityHeaders = createSecurityHeaders();
      if (securityHeaders) {
        app.use(securityHeaders);
      }

      if (isEnabled(process.env.TRUST_TENANT_HEADER)) {
        logger.warn(
          '[Security] TRUST_TENANT_HEADER is active. Ensure your reverse proxy strips and sets ' +
            'X-Tenant-Id — untrusted clients must not be able to supply it directly.',
        );
      } else if (isEnabled(process.env.TENANT_ISOLATION_STRICT)) {
        logger.warn(
          '[Security] TENANT_ISOLATION_STRICT is active while TRUST_TENANT_HEADER is disabled. ' +
            'Pre-authentication tenant headers will be ignored.',
        );
      }

      const application = await initializeApplicationRuntime({
        registry,
        identity: maintenance.identity,
        recordOriginalPublication: connected.statusUsage?.recordOriginalPublication,
        projectRoot: path.resolve(__dirname, '../..'),
        shutdownTeardownReserveMs: SHUTDOWN_TEARDOWN_RESERVE_MS,
        signal: startupSignal,
        onFailure: failStartup,
      });
      startupSignal.throwIfAborted();

      const { appConfig, uploads } = application;
      await configureGenerationStreams();
      startupSignal.throwIfAborted();
      uploads?.configureSourceReplay(GenerationJobManager);
      await connected.completeBootstrap();
      startupSignal.throwIfAborted();
      return {
        maintenance,
        metricsMiddleware,
        metricsRouter,
        connected,
        application,
        appConfig,
        uploads,
      };
    });
    const rejectChatStartsUntilReady = maintenance.admissionMiddleware;
    registerShutdownTask('private maintenance listener', () => maintenance.close(), {
      priority: 110,
    });
    await maintenance.listen();
    startupSignal.throwIfAborted();
    // No File sweep, public listener or background dispatch is admitted before this exact startup B.
    await maintenance.waitForStartupRelease(startupSignal);
    startupSignal.throwIfAborted();
    await connected.start();
    startupSignal.throwIfAborted();
    await application.start();
    startupSignal.throwIfAborted();

    /* Route modules build their rate limiters as they load, so they load only after the
     * startup checks have applied `rateLimits` from librechat.yaml. */
    const routes = require('./routes');
    if (routes.auth.browserMaintenance.pauseAdmissions !== browserMaintenance.pauseAdmissions)
      throw new Error('Browser startup owner changed during route construction');

    const indexPath = path.join(appConfig.paths.dist, 'index.html');
    let indexHTML = fs.readFileSync(indexPath, 'utf8');

    // In order to provide support to serving the application in a sub-directory
    // We need to update the base href if the DOMAIN_CLIENT is specified and not the root path
    if (process.env.DOMAIN_CLIENT) {
      const clientUrl = new URL(process.env.DOMAIN_CLIENT);
      const baseHref = clientUrl.pathname.endsWith('/')
        ? clientUrl.pathname
        : `${clientUrl.pathname}/`;
      if (baseHref !== '/') {
        logger.info(`Setting base href to ${baseHref}`);
        indexHTML = indexHTML.replace(/base href="\/"/, `base href="${baseHref}"`);
      }
    }

    /* The composer lays out against whether a footer bar sits beneath it, and
       `/api/config` answers that only after it has painted. One shell serves every
       request, before there is a caller whose overrides could be resolved, so the
       answer is the deployment's base configuration; `/api/config` resolves the
       caller's and the client prefers it. */
    indexHTML = injectConfiguredFooterBootstrap(indexHTML, {
      customFooter: process.env.CUSTOM_FOOTER,
    });

    const presentation = createPresentation({
      html: indexHTML,
      manifestRaw: fs.readFileSync(path.join(appConfig.paths.dist, 'manifest.webmanifest'), 'utf8'),
      appTitle: process.env.APP_TITLE,
      interfaceConfig: appConfig.interfaceConfig,
    });

    const cspPolicy = createCspPolicy();
    const shellCache = shellCacheHeaders(cspPolicy != null);

    const sendIndexHtml = (req, res) => {
      res.set(shellCache);
      res.vary(QUERY_DEVTOOLS_HEADER);

      const lang = req.cookies.lang || req.headers['accept-language']?.split(',')[0] || 'en-US';
      let updatedIndexHtml = presentation.render(lang);
      const emailLanding = /\/login\/email-code\/?$/.test(req.path);
      if (emailLanding) {
        res.set({
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
          'X-Frame-Options': 'DENY',
        });
        res.append('Content-Security-Policy', "frame-ancestors 'none'; connect-src 'self'");
        updatedIndexHtml = emailCodeLandingHtml(updatedIndexHtml, req.headers);
      } else {
        updatedIndexHtml = maybeInjectQueryDevtoolsBootstrap(updatedIndexHtml, req);
      }

      /* Nonce last: every injected script above must be stamped too. */
      if (cspPolicy) {
        const csp = issueCsp(cspPolicy);
        res.append(csp.headerName, csp.headerValue);
        updatedIndexHtml = applyCspNonce(updatedIndexHtml, csp.nonce);
      }

      res.type('html');
      res.send(updatedIndexHtml);
    };

    app.get('/health', (_req, res) => res.status(200).send('OK'));
    app.get('/livez', (_req, res) => res.status(200).send('OK'));
    app.get('/readyz', maintenance.readinessHandler);

    /* Middleware */
    app.use(requestContextMiddleware);
    app.use('/api', maintenance.mutationMiddleware);
    app.use('/api/agents/chat', agentStartupIngressMiddleware);
    app.use(metricsMiddleware);
    app.use(noIndex);
    // This App accepts metadata only. The ingress sends document bodies to isolated Intake.
    app.use(cookieParser());
    app.use(authAdmissionMiddleware);
    app.use(passport.initialize());
    passport.use(jwtLogin());
    passport.use(passportLogin());
    if (uploads) {
      app.use('/api/uploads', requireJwtAuth, uploads.router);
    } else {
      app.use('/api/uploads', (_req, res) => res.status(503).json({ code: 'unavailable' }));
    }
    app.use(
      '/api/workspaces',
      requireJwtAuth,
      require('./routes/workspaces').createWorkspaceRouter(),
    );
    // Enforce the code-request cap on incoming bytes before the general JSON parser.
    app.use(
      '/api/auth/email-code',
      express.json({ limit: 4096, strict: true, inflate: false }),
      (error, _req, res, next) =>
        error ? res.status(400).json({ code: 'EMAIL_CODE_INVALID_REQUEST' }) : next(),
    );
    app.use(createManagedIntakeIngress());
    app.use(excludeRumBodyParser(express.json({ limit: '3mb' })));
    app.use(excludeRumBodyParser(express.urlencoded({ extended: true, limit: '3mb' })));
    app.use(handleJsonParseError);

    /**
     * Express 5 Compatibility: Make req.query writable for mongoSanitize
     * In Express 5, req.query is read-only by default, but express-mongo-sanitize needs to modify it
     */
    app.use((req, _res, next) => {
      Object.defineProperty(req, 'query', {
        ...Object.getOwnPropertyDescriptor(req, 'query'),
        value: req.query,
        writable: true,
      });
      next();
    });

    app.use(mongoSanitize());
    app.use(cors());

    if (!isEnabled(DISABLE_COMPRESSION)) {
      app.use(compression());
    } else {
      console.warn('Response compression has been disabled via DISABLE_COMPRESSION.');
    }

    app.get('/index.html', sendIndexHtml);
    app.get('/manifest.webmanifest', presentation.manifestHandler);
    app.use(
      staticCache(appConfig.paths.dist, {
        runtimeAssets: appConfig.interfaceConfig?.appLogo
          ? [
              ...Object.values(appConfig.interfaceConfig.appLogo),
              ...(appConfig.interfaceConfig.pwaIcons ?? []).map((icon) => icon.src),
              'assets/favicon-16x16.png',
              'assets/favicon-32x32.png',
              'assets/apple-touch-icon-180x180.png',
            ]
          : [],
      }),
    );
    app.use(staticCache(appConfig.paths.fonts));
    app.use(staticCache(appConfig.paths.assets));

    if (telemetry.enabled) {
      app.use(telemetry.telemetryMiddleware);
    }
    app.use('/api/agents/chat', agentStartupTelemetryMiddleware);

    if (!ALLOW_SOCIAL_LOGIN) {
      console.warn('Social logins are disabled. Set ALLOW_SOCIAL_LOGIN=true to enable them.');
    }

    /* OAUTH */

    /* LDAP Auth */
    if (process.env.LDAP_URL && process.env.LDAP_USER_SEARCH_BASE) {
      passport.use(ldapLogin);
    }

    if (isEnabled(ALLOW_SOCIAL_LOGIN)) {
      await configureSocialLogins(app, appConfig);
      startupSignal.throwIfAborted();
    }

    /* Per-request capability cache — must be registered before any route that calls hasCapability */
    app.use(capabilityContextMiddleware);

    /* Pre-auth tenant context for unauthenticated routes that need tenant scoping.
     * The reverse proxy / auth gateway sets `X-Tenant-Id` header for multi-tenant deployments. */
    app.use('/oauth', preAuthTenantMiddleware, routes.oauth);
    /* API Endpoints */
    app.use('/api/auth', preAuthTenantMiddleware, routes.auth);
    app.use('/api/insights', routes.insights);
    app.use('/api/status', routes.status);
    app.use('/api/admin', routes.adminAuth);
    app.use('/api/admin/config', routes.adminConfig);
    app.use('/api/admin/code-environments', routes.adminCodeEnvironments);
    app.use('/api/code-environments', routes.codeEnvironments);
    app.use('/api/admin/langfuse', routes.adminLangfuse);
    app.use('/api/admin/grants', routes.adminGrants);
    app.use('/api/admin/groups', routes.adminGroups);
    app.use('/api/admin/roles', routes.adminRoles);
    app.use('/api/admin/skills', routes.adminSkills);
    app.use('/api/admin/users', routes.adminUsers);
    app.use('/api/admin/audit-log', routes.adminAuditLog);
    app.use('/api/actions', routes.actions);
    app.use('/api/keys', routes.keys);
    app.use('/api/api-keys', routes.apiKeys);
    app.use('/api/user', routes.user);
    app.use('/api/search', routes.search);
    app.use('/api/messages', routes.messages);
    app.use('/api/convos', routes.convos);
    app.use('/api/traces', routes.traces);
    app.use('/api/presets', routes.presets);
    app.use('/api/projects', routes.projects);
    app.use('/api/prompts', routes.prompts);
    app.use('/api/skills', routes.skills);
    app.use('/api/categories', routes.categories);
    app.use('/api/endpoints', routes.endpoints);
    app.use('/api/balance', routes.balance);
    app.use('/api/models', routes.models);
    app.use('/api/config', preAuthTenantMiddleware, optionalJwtAuth, routes.config);
    app.use('/api/assistants', routes.assistants);
    app.use('/api/files', await routes.files.initialize());
    startupSignal.throwIfAborted();
    app.use(
      '/images/',
      createValidateImageRequest({
        secureImageLinks: appConfig.secureImageLinks,
      }),
      routes.staticRoute,
    );
    app.use('/api/share', preAuthTenantMiddleware, routes.share);
    app.use('/api/roles', routes.roles);
    app.use('/api/agents/chat', rejectChatStartsUntilReady);
    app.use('/api/agents', routes.agents);
    app.use('/api/banner', routes.banner);
    app.use('/api/memories', routes.memories);
    app.use('/api/schedules', rejectScheduleWritesUntilReady, routes.schedules);
    app.use('/api/permissions', routes.accessPermissions);

    app.use('/api/tags', routes.tags);
    app.use('/api/mcp', routes.mcp);
    app.use('/api/rum', routes.rum);
    app.use('/metrics', metricsRouter);
    app.use('/api', routes.openapi);
    /** 404 for unmatched API routes */
    app.use('/api', apiNotFound);
    /** SPA fallback - serve index.html for all unmatched routes */
    app.use(createSpaFallback(sendIndexHtml));
    /** Record trace errors before the final error controller. */
    if (telemetry.enabled) {
      app.use(telemetry.telemetryErrorMiddleware);
    }
    /** Error handler (must be last - Express identifies error middleware by its 4-arg signature) */
    app.use(ErrorController);
    await new Promise((resolve, reject) => {
      const server = app.listen(port, host, async (err) => {
        if (err) {
          logger.error('Failed to start server:', err);
          reject(err);
          return;
        }
        if (host === '0.0.0.0') {
          logger.info(
            `Server listening on all interfaces at port ${port}. Use http://localhost:${port} to access it`,
          );
        } else {
          logger.info(
            `Server listening at http://${host == '0.0.0.0' ? 'localhost' : host}:${port}`,
          );
        }
        // Join post-listen initialization to the same original startup operation.
        try {
          startupSignal.throwIfAborted();
          await runAsSystem(async () => {
            await initializeMCPs();
            startupSignal.throwIfAborted();
            await initializeOAuthReconnectManager();
            startupSignal.throwIfAborted();
          });
          await checkMigrations();
          startupSignal.throwIfAborted();
          const inspectFlags = process.execArgv.some((arg) => arg.startsWith('--inspect'));
          if (inspectFlags || isEnabled(process.env.MEM_DIAG)) {
            memoryDiagnostics.start();
          }
          await initializeAgentTriggerService({
            address: server.address(),
            completionResultBatchSize:
              appConfig?.endpoints?.agents?.backgroundTasks?.completionResultBatchSize,
            completionReceiptBatching:
              appConfig?.endpoints?.agents?.backgroundTasks?.completionReceiptBatching,
            idlePolling: appConfig?.endpoints?.agents?.eventDriven?.idlePolling,
          });
          startupSignal.throwIfAborted();
          const scheduleEngineArmed = (await initializeScheduleEngine()) != null;
          startupSignal.throwIfAborted();
          scheduleEngineState = scheduleEngineArmed ? 'armed' : 'unavailable';
          if (!scheduleEngineArmed) {
            // Terminal, not transient: arming is attempted once, so schedule writes are refused
            // for the life of this process. Logged at error level because the only other signal
            // an operator gets is a 503 on every write — every other health signal stays green.
            logger.error(
              '[schedules] write routes are PERMANENTLY unavailable in this process: the engine did not arm. ' +
                'Resolve the cause logged above and restart.',
            );
          }
          await uploads?.start();
          startupSignal.throwIfAborted();
          serverReady = true;
          logger.info('Server readiness checks passing.');
          resolve();
        } catch (initErr) {
          serverReady = false;
          logger.error('Post-listen initialization failed:', initErr);
          reject(initErr);
        }
      });
      configureServerTimeouts(server);
      logger.info('HTTP server timeout configuration', {
        keepAliveTimeout: server.keepAliveTimeout,
        keepAliveTimeoutBuffer: server.keepAliveTimeoutBuffer,
        headersTimeout: server.headersTimeout,
        requestTimeout: server.requestTimeout,
      });
      setupGracefulShutdown(server, { deferHttpCloseUntilPreDrain: true });
    });
  };
  return startServer();
}
/** Install the existing shutdown owner before the original startup can acquire resources. */
setupGracefulShutdown(null, { deferHttpCloseUntilPreDrain: true });
const startupSignal = getShutdownSignal();
const failStartup = () => {
  serverReady = false;
  void requestGracefulShutdown('startup_failure').catch(() => undefined);
};
let startupOriginal;
registerShutdownTask(
  'web database bootstrap originals',
  async () => {
    await startupOriginal?.catch(() => undefined);
    await database?.modelBootstrap.join();
  },
  { phase: 'pre-drain', priority: 94 },
);
startupOriginal = Promise.resolve().then(prepareAndStart);
registerShutdownTask(
  'web startup original',
  async () => {
    await startupOriginal.catch(() => undefined);
  },
  { phase: 'pre-drain', priority: 95 },
);
void startupOriginal.catch((err) => {
  logger.error('Failed to start server:', err);
  failStartup();
});
let messageCount = 0;
process.on('uncaughtException', (err) => {
  if (!err.message.includes('fetch failed')) {
    logger.error('There was an uncaught error:', err);
  }
  if (err.message && err.message?.toLowerCase()?.includes('abort')) {
    logger.warn('There was an uncatchable abort error.');
    return;
  }
  if (err.message.includes('GoogleGenerativeAI')) {
    logger.warn(
      '\n\n`GoogleGenerativeAI` errors cannot be caught due to an upstream issue, see: https://github.com/google-gemini/generative-ai-js/issues/303',
    );
    return;
  }
  if (err.message.includes('fetch failed')) {
    if (messageCount === 0) {
      logger.warn('Meilisearch error, search will be disabled');
      messageCount++;
    }
    return;
  }
  if (err.message.includes('OpenAIError') || err.message.includes('ChatCompletionMessage')) {
    logger.error(
      '\n\nAn Uncaught `OpenAIError` error may be due to your reverse-proxy setup or stream configuration, or a bug in the `openai` node package.',
    );
    return;
  }
  if (err.stack && err.stack.includes('@librechat/agents')) {
    logger.error(
      '\n\nAn error occurred in the agents system. The error has been logged and the app will continue running.',
      {
        message: err.message,
        stack: err.stack,
      },
    );
    return;
  }
  if (isEnabled(process.env.CONTINUE_ON_UNCAUGHT_EXCEPTION)) {
    logger.error('Unhandled error encountered. The app will continue running.', {
      name: err?.name,
      message: err?.message,
      stack: err?.stack,
    });
    return;
  }
  process.exit(1);
});
/**
 * Unhandled promise rejection handler.
 *
 * Node 15+ terminates the process by default when a promise rejection is
 * unhandled. MCP OAuth reconnect storms and streamable-HTTP transport resets
 * can produce transient fire-and-forget rejections (ECONNRESET, token refresh
 * races) that are recoverable — the server should log and keep serving other
 * requests rather than silently crash under load.
 *
 * Non-Error reasons are forwarded as-is so structured payloads (e.g.
 * `{ code: "ECONNRESET", errno: -104 }`) survive instead of being collapsed to
 * "[object Object]" by `String()`.
 */
process.on('unhandledRejection', (reason) => {
  if (reason instanceof Error) {
    logger.error('Unhandled promise rejection. The app will continue running.', {
      name: reason.name,
      message: reason.message,
      stack: reason.stack,
      cause: reason.cause,
    });
    return;
  }
  logger.error('Unhandled promise rejection. The app will continue running.', { reason });
});
/** Export app for easier testing purposes */
module.exports = app;
