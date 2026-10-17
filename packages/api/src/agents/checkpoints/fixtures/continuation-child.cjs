/* Real compiled host/SDK process. Only the external model is synthetic. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

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
    await mongoose.connect(input.mongoUri, { dbName: input.dbName });
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
    });
    await mongoose.disconnect();
    process.disconnect();
  } catch (error) {
    process.stderr.write(`${error.stack ?? error}\n`);
    await mongoose?.disconnect();
    process.exitCode = 1;
    process.disconnect?.();
  }
});
