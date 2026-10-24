/* Real compiled host/SDK process. Model, approval receipt and original bytes are explicit fixtures. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { createHash, randomUUID } = require('node:crypto');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const deadline = setTimeout(() => {
  process.stderr.write('Continuation fixture deadline exceeded\n');
  process.exit(124);
}, 55_000);
deadline.unref();

process.once('message', async (input) => {
  let mongoose;
  const managers = [];
  const redisClients = [];
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(input.sdkRoot, 'package.json'), 'utf8'));
    assert.equal(manifest.name, '@librechat/agents');
    const sdkRequire = Module.createRequire(path.join(input.sdkRoot, 'package.json'));
    const originalResolve = Module._resolveFilename;
    // Resolve only declared PUBLIC SDK exports into the exact build supplied by the host.
    Module._resolveFilename = function (request, parent, ...rest) {
      if (request === '@librechat/agents' || request.startsWith('@librechat/agents/')) {
        const key =
          request === '@librechat/agents' ? '.' : `.${request.slice('@librechat/agents'.length)}`;
        assert.ok(Object.hasOwn(manifest.exports, key), `Undeclared SDK export: ${key}`);
        const entry = manifest.exports[key].require;
        assert.equal(typeof entry, 'string');
        const target = path.resolve(input.sdkRoot, entry);
        assert.ok(target.startsWith(`${path.resolve(input.sdkRoot)}${path.sep}`));
        return originalResolve.call(this, target, parent, ...rest);
      }
      return originalResolve.call(this, request, parent, ...rest);
    };
    const sdk = sdkRequire('@librechat/agents');
    assert.equal(sdk.CHECKPOINT_CONTINUATION_VERSION, 1);
    assert.equal(typeof sdk.Run.prototype.continueFromCheckpoint, 'function');
    const { BaseChatModel } = sdkRequire('@langchain/core/language_models/chat_models');
    const { AIMessage, AIMessageChunk, HumanMessage } = sdkRequire('@langchain/core/messages');
    const { ChatGenerationChunk } = sdkRequire('@langchain/core/outputs');
    const host = require(input.apiEntry);
    mongoose = require('mongoose');
    await mongoose.connect(input.mongoUri, { dbName: input.dbName, monitorCommands: true });
    mongoose.connection.getClient().on('commandFailed', (event) => {
      fs.appendFileSync(
        `${input.effects}.mongo-failures.jsonl`,
        `${JSON.stringify({
          command: event.commandName,
          code: event.failure?.code,
          labels: event.failure?.errorLabels,
        })}\n`,
      );
    });
    const schemas = require('@librechat/data-schemas');
    process.env.UPLOAD_SECURITY_POLICY_SHA256 = input.sourcePolicy;
    process.env.CORTEX_UPLOAD_MANAGEMENT_ENABLED = 'true';
    const models = schemas.createModels(mongoose);
    // Each fresh process registers the native quota owner; the parent already initialized it.
    schemas.createUploadManagementRepository(mongoose);
    const quota = await mongoose.models.UploadCounter.findById('global').lean();
    assert.equal(quota?.value.enabled, true);
    assert.equal(quota?.value.reconciled, true);
    const methods = schemas.createGenerationAdmissionMethods(mongoose);
    const sources = schemas.createCheckpointSourceMethods(mongoose);
    const sourceOwner = { userId: input.scope.userId, tenantId: input.scope.tenantId };
    const { getConvoOwnership } = schemas.createMethods(mongoose);
    await methods.ensureGenerationAdmissionIndexes();
    assert.equal(typeof host.GenerationAdmissionCoordinator, 'function');
    assert.equal(typeof host.createMaintenanceIdentity, 'function');
    const nativeIdentity = host.createMaintenanceIdentity(
      {
        POD_UID: input.podUid,
        BUILD_COMMIT: input.buildCommit,
      },
      true,
    );
    const redisUrl = new URL(input.redisUri);
    assert.equal(redisUrl.protocol, 'redis:');
    assert.equal(redisUrl.hostname, '127.0.0.1');
    assert.equal(redisUrl.username + redisUrl.password, '');
    assert.match(input.redisPrefix, /^checkpoint-process:[a-f0-9-]+:$/);
    const Redis = require('ioredis');
    const managerOwner = async () => {
      const publisher = new Redis(input.redisUri, {
        keyPrefix: input.redisPrefix,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null,
      });
      const subscriber = publisher.duplicate();
      redisClients.push(publisher, subscriber);
      await Promise.all([publisher.ping(), subscriber.ping()]);
      const jobStore = new host.RedisJobStore(publisher);
      const eventTransport = new host.RedisEventTransport(publisher, subscriber);
      const result = new host.GenerationJobManagerClass({ jobStore, eventTransport });
      result.configure({ jobStore, eventTransport, isRedis: true, cleanupOnComplete: false });
      result.configureGenerationAdmission({
        required: true,
        methods,
        ownerInstanceId: nativeIdentity.podUid,
        processBootId: nativeIdentity.incarnation,
      });
      managers.push(result);
      if (input.storeCommitUnknown) {
        const transition = jobStore.transitionStatus.bind(jobStore);
        jobStore.transitionStatus = async (...args) => {
          const committed = await transition(...args);
          if (committed && args[1].expectProviderExecutionId)
            throw new Error('Injected lost acknowledgment after actual Redis CAS');
          return committed;
        };
      }
      return result;
    };
    assert.equal(sha256(fs.readFileSync(__filename)), input.graphFingerprint);
    assert.equal(sha256('checkpoint-only-v1; synthetic-model; no-tools'), input.policyFingerprint);
    let admission;
    let recovery;
    let sourceBinding;
    let capturedMessages;
    let nativeJob;
    let executionJob;
    let executionManager;
    const authorizedPrincipal = async (principalId, conversationId, tenantId) => {
      const user = await models.User.findOne({
        _id: principalId,
        tenantId,
        authDisabled: false,
        authVersion: 0,
      }).lean();
      const conversation = await getConvoOwnership(principalId, conversationId, tenantId);
      return (
        !!user &&
        conversation?.user === principalId &&
        conversation.tenantId === tenantId &&
        !conversation.subagentThread
      );
    };
    if (input.phase === 'first') {
      assert.equal(
        await authorizedPrincipal(input.scope.userId, input.scope.threadId, input.scope.tenantId),
        true,
      );
      const session = await mongoose.startSession();
      try {
        session.startTransaction();
        const captured = await sources.captureCheckpointSources(
          sourceOwner,
          input.sourceInput,
          session,
        );
        await session.commitTransaction();
        sourceBinding = captured.binding;
        capturedMessages = captured.messages;
      } finally {
        await session.endSession();
      }
      if (input.captureCommitUnknown) {
        // Explicit lost capture acknowledgment after a real commit: no native job or provider.
        process.send({ type: 'capture-denied' });
        return;
      }
      const binding = host.generationRequestBinding(input.clientRequestId, {
        runId: input.runId,
        conversationId: input.scope.threadId,
        sourceBindingSha256: sourceBinding.bindingSha256,
        sourceInput: input.sourceInput,
      });
      const continuation = {
        version: 1,
        runId: input.runId,
        threadId: input.scope.threadId,
        checkpointNamespace: input.scope.checkpointNamespace,
        graphFingerprint: input.graphFingerprint,
        policyFingerprint: input.policyFingerprint,
        mode: 'checkpoint-only-v1',
        sourceBindingSha256: sourceBinding.bindingSha256,
      };
      const manager = await managerOwner();
      const job = await schemas.tenantStorage.run({ tenantId: input.scope.tenantId }, async () => {
        const claim = await manager.claimGeneration(
          input.scope.userId,
          input.clientRequestId,
          input.scope.threadId,
          input.scope.threadId,
          2,
          binding,
        );
        assert.equal(claim.claimed, true);
        return manager.createJob(input.scope.threadId, input.scope.userId, input.scope.threadId, {
          trustedTenantId: input.scope.tenantId,
          generationAdmission: binding,
          checkpointContinuation: continuation,
          idempotencyClientRequestId: input.clientRequestId,
          idempotencyClaimToken: claim.existing.claimToken,
        });
      });
      executionJob = job;
      executionManager = manager;
      nativeJob = {
        createdAt: job.createdAt,
        providerExecutionId: job.metadata.providerExecutionId,
        checkpointNamespace: job.metadata.checkpointNamespace,
        generationProtocolVersion: job.metadata.generationProtocolVersion,
      };
      assert.equal(
        await manager.beginProviderExecution(
          job.streamId,
          job.createdAt,
          job.metadata.providerExecutionId,
        ),
        true,
      );
      const current = await methods.getGenerationAdmission({
        tenantId: input.scope.tenantId,
        principalId: input.scope.userId,
        clientRequestId: input.clientRequestId,
      });
      assert.equal(current.ok, true);
      assert.equal(current.value.state, 'dispatching');
      admission = schemas.snapshotGenerationCheckpointAdmission(current.value);
      assert.equal(admission.generationEpoch, job.createdAt);
      assert.equal(admission.segmentId, job.metadata.providerExecutionId);
      assert.equal(admission.continuation.checkpointNamespace, job.metadata.checkpointNamespace);
    } else {
      for (const key of ['sourceBinding', 'sourceInput', 'capturedMessages', 'expectedSourceText'])
        assert.equal(Object.hasOwn(input, key), false, `Restart must not receive ${key}`);
      assert.equal(input.config.configurable.checkpoint_id, undefined);
      const persisted = await methods.getGenerationAdmission({
        tenantId: input.scope.tenantId,
        principalId: input.scope.userId,
        clientRequestId: input.clientRequestId,
      });
      assert.equal(persisted.ok, true);
      assert.ok(persisted.value);
      input.predecessor = schemas.snapshotGenerationCheckpointAdmission(persisted.value);
      if (input.sourceCommitUnknown) {
        const recover = methods.recoverGenerationAdmission;
        methods.recoverGenerationAdmission = async (...args) => {
          const result = await recover(...args);
          // The real recovery committed; its acknowledgment is deliberately lost.
          return result.ok ? { ok: false, error: { code: 'OUTCOME_UNKNOWN' } } : result;
        };
      }
      const terminationBytes = fs.readFileSync(input.terminationFile);
      const terminated = JSON.parse(terminationBytes);
      assert.deepEqual(terminated.admission, input.predecessor);
      assert.deepEqual(terminated.exit, { code: null, signal: 'SIGKILL' });
      assert.equal(terminated.identity.pid, input.predecessorPid);
      assert.equal(terminated.nativeIdentity.podUid, input.predecessor.ownerInstanceId);
      assert.equal(terminated.nativeIdentity.incarnation, input.predecessor.processBootId);
      assert.notEqual(nativeIdentity.incarnation, input.predecessor.processBootId);
      if (fs.existsSync(`/proc/${input.predecessorPid}/stat`)) {
        const fields = fs
          .readFileSync(`/proc/${input.predecessorPid}/stat`, 'utf8')
          .split(')')
          .pop()
          .trim()
          .split(/\s+/);
        // PID reuse is not proof that the original process survived.
        assert.notEqual(fields[19], terminated.identity.startTicks);
      }
      let aclChecks = 0;
      let effectChecks = 0;
      let releaseEvidence;
      const bothEvidence = new Promise((resolve) => {
        releaseEvidence = resolve;
      });
      const ports = {
        authorize: async (prior) => {
          aclChecks++;
          assert.deepEqual(prior, input.predecessor);
          if (!(await authorizedPrincipal(prior.principalId, prior.conversationId, prior.tenantId)))
            return false;
          return true;
        },
        recoverSources: host.createCheckpointSourceRecovery(input.storage),
        confirmTerminatedOwner: async (prior) => {
          assert.deepEqual(prior, terminated.admission);
          return { predecessor: prior, terminationEvidenceSha256: sha256(terminationBytes) };
        },
        reconcileEffects: async (prior) => {
          assert.deepEqual(prior, input.predecessor);
          const bytes = fs.readFileSync(input.effects);
          const effects = bytes.toString('utf8').trim().split('\n').map(JSON.parse);
          assert.deepEqual(effects, [
            { phase: 'first', model: 'first', pid: input.predecessorPid },
          ]);
          const row = await methods.getGenerationAdmission(prior);
          assert.equal(row.ok, true);
          assert.equal(row.value.state, 'dispatching');
          assert.equal(row.value.processBootId, prior.processBootId);
          assert.ok(row.value.checkpointWriteRevision > 0);
          effectChecks++;
          if (effectChecks === 2) releaseEvidence();
          // Synchronize only the test callers: both compete against the same real DB fence.
          await bothEvidence;
          return {
            predecessor: prior,
            checkpointWriteRevision: row.value.checkpointWriteRevision,
            effectsEvidenceSha256: sha256(bytes),
          };
        },
      };
      const candidates = await Promise.all([managerOwner(), managerOwner()]);
      const segments = [randomUUID(), randomUUID()];
      const results = await Promise.all(
        candidates.map((owner, index) =>
          owner.recoverCheckpointGeneration(
            input.scope.threadId,
            input.predecessor,
            segments[index],
            ports,
          ),
        ),
      );
      const winners = results.filter(Boolean);
      if (input.expectedSourceDenial && !input.expireSourceAt) {
        assert.equal(winners.length, 0);
        const current = await methods.getGenerationAdmission(input.predecessor);
        assert.equal(current.ok, true);
        if (input.sourceCommitUnknown || input.storeCommitUnknown) {
          assert.equal(current.value.state, 'admitted');
          assert.equal(current.value.recoveries.length, 1);
        } else {
          assert.deepEqual(
            schemas.snapshotGenerationCheckpointAdmission(current.value),
            input.predecessor,
          );
        }
        for (let i = 0; i < candidates.length; i++)
          assert.equal(
            await candidates[i].beginProviderExecution(
              input.scope.threadId,
              input.predecessor.generationEpoch,
              segments[i],
            ),
            false,
          );
        const durableJob = await candidates[0].getJobStore().getJob(input.scope.threadId);
        assert.equal(durableJob.createdAt, input.predecessor.generationEpoch);
        assert.equal(
          durableJob.providerExecutionId === input.predecessor.segmentId,
          !input.storeCommitUnknown,
        );
        process.send({ type: 'denied', admission: current.value, aclChecks, effectChecks });
        return;
      }
      assert.equal(winners.length, 1);
      const receipt = winners[0];
      admission = receipt.admission;
      sourceBinding = receipt.source.sourceBinding;
      assert.equal(sourceBinding.bindingSha256, admission.continuation.sourceBindingSha256);
      input.config = {
        ...input.config,
        configurable: {
          ...input.config.configurable,
          thread_id: receipt.source.checkpoint.threadId,
          checkpoint_ns: receipt.source.checkpoint.checkpointNs,
          checkpoint_id: receipt.source.checkpoint.checkpointId,
        },
      };
      const winner = results.indexOf(receipt);
      const loser = 1 - winner;
      assert.equal(
        await candidates[loser].beginProviderExecution(
          input.scope.threadId,
          input.predecessor.generationEpoch,
          segments[loser],
        ),
        false,
      );
      executionManager = candidates[winner];
      executionJob = await executionManager.getJob(input.scope.threadId);
      assert.ok(executionJob);
      assert.equal(executionJob.createdAt, input.predecessor.generationEpoch);
      assert.equal(executionJob.metadata.providerExecutionId, admission.segmentId);
      if (input.expireSourceAt) {
        const now = Date.now;
        const dispatch = methods.dispatchGenerationAdmission;
        try {
          if (input.expireSourceAt === 'before') Date.now = () => receipt.source.expiresAt;
          else
            methods.dispatchGenerationAdmission = async (...args) => {
              const result = await dispatch(...args);
              Date.now = () => receipt.source.expiresAt;
              return result;
            };
          assert.equal(
            await executionManager.beginProviderExecution(
              input.scope.threadId,
              input.predecessor.generationEpoch,
              admission.segmentId,
            ),
            false,
          );
        } finally {
          Date.now = now;
          methods.dispatchGenerationAdmission = dispatch;
        }
        if (input.expireSourceAt === 'authorize')
          assert.equal(
            await executionManager.markProviderExecutionDrained(
              input.scope.threadId,
              input.predecessor.generationEpoch,
              admission.segmentId,
            ),
            true,
          );
        const current = await methods.getGenerationAdmission(input.predecessor);
        assert.equal(current.ok, true);
        assert.equal(
          current.value.state,
          input.expireSourceAt === 'before' ? 'admitted' : 'dispatching',
        );
        process.send({ type: 'denied', admission: current.value, aclChecks, effectChecks });
        return;
      }
      assert.equal(
        await executionManager.beginProviderExecution(
          input.scope.threadId,
          input.predecessor.generationEpoch,
          admission.segmentId,
        ),
        true,
      );
      let losingCallback = false;
      const rejected = await methods.writeGenerationCheckpoint(
        { ...admission, segmentId: segments[loser] },
        async () => {
          losingCallback = true;
          throw new Error('Losing recovery must never enter its checkpoint write');
        },
      );
      assert.deepEqual(rejected, { ok: false, error: { code: 'HELD' } });
      assert.equal(losingCallback, false);
      recovery = { winners: winners.length, aclChecks, losingWriteRejected: !losingCallback };
    }
    let run;
    let blocked = false;
    let fetchCalls = 0;
    const closedSteps = [];
    globalThis.fetch = async () => {
      fetchCalls++;
      throw new Error('No external HTTP is allowed in the continuation fixture');
    };
    class SyntheticModel extends BaseChatModel {
      constructor(options) {
        super(options);
        this.model = options.model;
      }
      _llmType() {
        return 'synthetic-continuation-proof';
      }
      bindTools() {
        return this;
      }
      async response(messages) {
        assert.ok(
          messages.some(
            (message) =>
              typeof message.content === 'string' &&
              sha256(message.content) === input.expectedSourceTextSha256,
          ),
        );
        if (this.model === 'second' && input.phase === 'first') {
          assert.equal(blocked, false);
          blocked = true;
          const state = await run.graphRunnable.getState(input.config);
          process.send({
            type: 'quiescent',
            checkpointId: state.config.configurable.checkpoint_id,
            next: state.next,
            runId: state.values.runStepState.runId,
            steps: closedSteps,
            admission,
            nativeIdentity,
            sourceBinding,
            nativeJob,
          });
          // No second response/effect is produced in this process. The parent joins it.
          await new Promise(() => {});
        }
        fs.appendFileSync(
          input.effects,
          `${JSON.stringify({ phase: input.phase, model: this.model, pid: process.pid })}\n`,
        );
        return `answer-${this.model}`;
      }
      async _generate(messages) {
        const text = await this.response(messages);
        return { generations: [{ text, message: new AIMessage({ content: text }) }] };
      }
      async *_streamResponseChunks(messages) {
        const text = await this.response(messages);
        yield new ChatGenerationChunk({ text, message: new AIMessageChunk({ content: text }) });
      }
    }
    sdk.registerProvider({
      provider: 'continuation-proof',
      model: SyntheticModel,
      family: 'generic',
    });
    const agent = (id, model) => ({
      id,
      name: id,
      description: null,
      avatar: null,
      created_at: 0,
      provider: 'continuation-proof',
      endpoint: 'continuation-proof',
      model,
      model_parameters: { model },
      tools: [],
      ...(id === 'agent_a'
        ? { edges: [{ from: 'agent_a', to: 'agent_b', edgeType: 'direct' }] }
        : {}),
    });
    run = await host.createRun({
      runId: input.runId,
      conversationId: input.scope.threadId,
      user: { id: input.scope.userId, tenantId: input.scope.tenantId },
      tenantId: input.scope.tenantId,
      durableCheckpointScope: input.scope,
      durableCheckpointAdmission: admission,
      durableCheckpointSourceBinding: sourceBinding,
      agents: [agent('agent_a', 'first'), agent('agent_b', 'second')],
      signal: executionJob.abortController.signal,
      centralTraceExportEnabled: false,
      customHandlers: {
        [sdk.GraphEvents.ON_RUN_STEP_CLOSED]: {
          handle: (_event, step) => {
            closedSteps.push(structuredClone(step));
          },
        },
      },
      appConfig: { endpoints: { agents: { checkpointer: input.storage } } },
      tokenCounter: (message) => JSON.stringify(message).length,
      streaming: false,
      streamUsage: false,
    });
    assert.ok(run instanceof sdk.Run, 'Native createRun must return the actual public SDK Run');
    if (input.phase === 'first') {
      await run.processStream(
        {
          messages: capturedMessages.map(
            (message) => new HumanMessage({ id: message.messageId, content: message.text }),
          ),
        },
        input.config,
      );
      throw new Error('First process must remain blocked before its second response');
    }
    await run.continueFromCheckpoint(input.config);
    const state = await run.graphRunnable.getState({
      configurable: { thread_id: input.scope.threadId, checkpoint_ns: '' },
    });
    assert.equal(
      await executionManager.completeJob(
        input.scope.threadId,
        undefined,
        admission.generationEpoch,
      ),
      true,
    );
    assert.equal(
      await executionManager.settleGenerationExecution(
        input.scope.threadId,
        admission.generationEpoch,
        admission.segmentId,
      ),
      true,
    );
    process.send({
      type: 'completed',
      next: state.next,
      checkpointId: state.config.configurable.checkpoint_id,
      messages: state.values.messages.map((message) => ({
        id: message.id,
        content: message.content,
      })),
      steps: closedSteps,
      fetchCalls,
      admission,
      nativeIdentity,
      recovery,
    });
  } catch (error) {
    process.stderr.write(`${error.stack ?? error}\n`);
    if (mongoose?.models.GenerationAdmission) {
      const records = await mongoose.models.GenerationAdmission.find(
        {},
        'state checkpointWriteRevision ownerInstanceId processBootId segmentId',
      ).lean();
      process.stderr.write(`Native admission at failure: ${JSON.stringify(records)}\n`);
    }
    process.exitCode = 1;
  } finally {
    for (const manager of managers) await manager.destroy({ settlementBudgetMs: 0 });
    for (const client of redisClients) client.disconnect();
    await mongoose?.disconnect();
    if (process.connected) process.disconnect();
  }
});
