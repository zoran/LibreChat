/* Real compiled host/SDK process. Only the external model is synthetic. */
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
    const models = schemas.createModels(mongoose);
    const methods = schemas.createGenerationAdmissionMethods(mongoose);
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
    const coordinator = () => {
      const result = new host.GenerationAdmissionCoordinator();
      result.configure({
        required: true,
        methods,
        ownerInstanceId: nativeIdentity.podUid,
        processBootId: nativeIdentity.incarnation,
      });
      return result;
    };
    assert.equal(sha256(fs.readFileSync(__filename)), input.graphFingerprint);
    assert.equal(sha256('checkpoint-only-v1; synthetic-model; no-tools'), input.policyFingerprint);
    let admission;
    let recovery;
    if (input.phase === 'first') {
      const owner = coordinator();
      const binding = host.generationRequestBinding(input.clientRequestId, {
        runId: input.runId,
        conversationId: input.scope.threadId,
      });
      const continuation = {
        version: 1,
        runId: input.runId,
        threadId: input.scope.threadId,
        checkpointNamespace: input.scope.checkpointNamespace,
        graphFingerprint: input.graphFingerprint,
        policyFingerprint: input.policyFingerprint,
        mode: 'checkpoint-only-v1',
      };
      await owner.enroll(
        input.scope.threadId,
        input.generationEpoch,
        input.segmentId,
        input.scope.userId,
        input.scope.tenantId,
        input.scope.threadId,
        1,
        binding,
        continuation,
      );
      assert.equal(
        await owner.authorize(
          input.scope.threadId,
          input.generationEpoch,
          input.segmentId,
          input.scope.userId,
          input.scope.tenantId,
          input.scope.threadId,
          false,
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
    } else {
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
          const user = await models.User.findOne({
            _id: prior.principalId,
            tenantId: prior.tenantId,
            authDisabled: false,
            authVersion: 0,
          }).lean();
          const conversation = await getConvoOwnership(
            prior.principalId,
            prior.conversationId,
            prior.tenantId,
          );
          return (
            !!user &&
            conversation?.user === prior.principalId &&
            conversation.tenantId === prior.tenantId &&
            !conversation.subagentThread
          );
        },
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
      const candidates = [coordinator(), coordinator()];
      const segments = [randomUUID(), randomUUID()];
      const results = await Promise.all(
        candidates.map((owner, index) =>
          owner.recoverCheckpoint(input.scope.threadId, input.predecessor, segments[index], ports),
        ),
      );
      const winners = results.filter(Boolean);
      assert.equal(winners.length, 1);
      admission = winners[0];
      const winner = results.indexOf(admission);
      const loser = 1 - winner;
      assert.equal(
        await candidates[loser].authorize(
          input.scope.threadId,
          input.generationEpoch,
          segments[loser],
          input.scope.userId,
          input.scope.tenantId,
          input.scope.threadId,
          false,
        ),
        false,
      );
      assert.equal(
        await candidates[winner].authorize(
          input.scope.threadId,
          input.generationEpoch,
          admission.segmentId,
          input.scope.userId,
          input.scope.tenantId,
          input.scope.threadId,
          false,
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
      async response() {
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
      async _generate() {
        const text = await this.response();
        return { generations: [{ text, message: new AIMessage({ content: text }) }] };
      }
      async *_streamResponseChunks() {
        const text = await this.response();
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
      agents: [agent('agent_a', 'first'), agent('agent_b', 'second')],
      signal: new AbortController().signal,
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
        { messages: [new HumanMessage('Synthetic two-step process proof')] },
        input.config,
      );
      throw new Error('First process must remain blocked before its second response');
    }
    await run.continueFromCheckpoint(input.config);
    const state = await run.graphRunnable.getState({
      configurable: { thread_id: input.scope.threadId, checkpoint_ns: '' },
    });
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
    await mongoose.disconnect();
    process.disconnect();
  } catch (error) {
    process.stderr.write(`${error.stack ?? error}\n`);
    if (mongoose?.models.GenerationAdmission) {
      const records = await mongoose.models.GenerationAdmission.find(
        {},
        'state checkpointWriteRevision ownerInstanceId processBootId segmentId',
      ).lean();
      process.stderr.write(`Native admission at failure: ${JSON.stringify(records)}\n`);
    }
    await mongoose?.disconnect();
    process.exitCode = 1;
    process.disconnect?.();
  }
});
