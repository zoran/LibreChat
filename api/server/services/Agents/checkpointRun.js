/** Server-only composition of native generation preparation and checkpoint input inspection. */
const mongoose = require('mongoose');
const { Run } = require('@librechat/agents');
const { snapshotGenerationCheckpointAdmission } = require('@librechat/data-schemas');
const { GenerationJobManager, createCheckpointNamespace } = require('@librechat/api');
const db = require('~/models');
const { disposeClient } = require('~/server/cleanup');

const hosts = new WeakSet();
const preparations = new WeakMap();
const unsupported = () => {
  throw Object.assign(new Error('Checkpoint-only execution does not support this capability'), {
    code: 'CHECKPOINT_PROFILE_UNSUPPORTED',
    status: 409,
  });
};

function assertAgents(agents) {
  if (!Array.isArray(agents) || !agents.length) unsupported();
  for (const agent of agents) {
    if (
      !agent ||
      (agent.tools?.length ?? 0) > 0 ||
      (agent.toolDefinitions?.length ?? 0) > 0 ||
      (agent.toolRegistry?.size ?? 0) > 0 ||
      agent.hasDeferredTools === true ||
      agent.codeEnvAvailable === true ||
      agent.stateful_code_sessions === true ||
      agent.statefulCodeSessions === true ||
      agent.skills_enabled === true ||
      (agent.manualSkillPrimes?.length ?? 0) > 0 ||
      (agent.alwaysApplySkillPrimes?.length ?? 0) > 0 ||
      (agent.backgroundToolNames?.length ?? 0) > 0 ||
      agent.subagents?.enabled === true ||
      (agent.subagents?.agent_ids?.length ?? 0) > 0 ||
      (agent.subagents?.graphs?.length ?? 0) > 0 ||
      (agent.subagentAgentConfigs?.length ?? 0) > 0 ||
      (agent.lazySubagentConfigs?.length ?? 0) > 0 ||
      (agent.subagentGraphConfigs?.length ?? 0) > 0 ||
      (agent.edges ?? []).some((edge) => edge.edgeType !== 'direct' || edge.condition != null)
    ) {
      unsupported();
    }
  }
}

function fingerprints(client) {
  const agents = [client.options.agent, ...(client.agentConfigs?.values() ?? [])];
  assertAgents(agents);
  const graph = agents.map((agent) => ({
    id: agent.id,
    provider: agent.provider,
    endpoint: agent.endpoint,
    model: agent.model,
    model_parameters: agent.model_parameters,
    instructions: agent.instructions,
    additional_instructions: agent.additional_instructions,
    edges: agent.edges,
    maxContextTokens: agent.maxContextTokens,
    max_context_tokens: agent.max_context_tokens,
    hide_sequential_outputs: agent.hide_sequential_outputs,
    useLegacyContent: agent.useLegacyContent,
  }));
  const config = client.options.req.config;
  const policy = {
    version: 1,
    profile: 'checkpoint-only-v1',
    filters: config?.filters,
    legacyPii: config?.messageFilter?.pii,
    summarization: config?.summarization,
    agents: config?.endpoints?.agents,
  };
  const hash = (value) => {
    const binding = GenerationJobManager.generationRequestBinding('checkpoint-profile-v1', value);
    if (!binding) throw new Error('Checkpoint profile could not be fingerprinted');
    return binding.requestFingerprint;
  };
  return { graphFingerprint: hash(graph), policyFingerprint: hash(policy) };
}

function getCheckpointPreparation(token, req) {
  if (token === undefined) return undefined;
  const context = preparations.get(token);
  if (!context || context.req !== req) throw new Error('Untrusted checkpoint preparation');
  return context;
}

function assertCheckpointRunHost(host) {
  if (host !== undefined && !hosts.has(host)) throw new Error('Untrusted checkpoint host');
}

/** Omitted by ordinary routes. This capability cannot be selected by request/config metadata. */
function createCheckpointRunHost() {
  const host = Object.freeze({
    async prepare({
      req,
      res,
      initializeClient,
      endpointOption,
      requestBody,
      binding,
      claimToken,
      conversationId,
      runId,
      text,
      messageOptions,
      protocol,
    }) {
      if (Run.checkpointInputInspectionVersion !== 1) {
        throw new Error('Checkpoint input inspection requires the qualified agents SDK');
      }
      if (
        !binding ||
        !claimToken ||
        protocol !== 2 ||
        req._isScheduledFire ||
        req._isAgentTrigger ||
        req.body?.compact === true ||
        req.body?.manualSkills?.length ||
        req.body?.addedConvo?.length ||
        req.body?.ephemeralAgent?.skills === true ||
        req.body?.codeWorkspaces?.length
      )
        unsupported();
      const owner = Object.freeze({ userId: req.user.id, tenantId: req.user.tenantId });
      const request = Object.freeze({ ...binding });
      const token = Object.freeze({});
      const controller = new AbortController();
      const abort = () => controller.abort();
      req.once?.('aborted', abort);
      const context = {
        req,
        assertAgents,
        sourceRetentionOptions(client) {
          if (client !== initialized?.client || !admission || controller.signal.aborted) {
            throw new Error('Checkpoint generation has not been acknowledged');
          }
          return { checkpointSourceBinding: captured.binding };
        },
        runOptions(client) {
          if (client !== initialized?.client || !admission || controller.signal.aborted) {
            throw new Error('Checkpoint generation has not been acknowledged');
          }
          const current = fingerprints(client);
          if (
            current.graphFingerprint !== receipt.continuation.graphFingerprint ||
            current.policyFingerprint !== receipt.continuation.policyFingerprint
          ) {
            throw new Error('Checkpoint execution changed after preparation');
          }
          return Object.freeze({
            durableCheckpointScope: Object.freeze({
              ...owner,
              threadId: conversationId,
              checkpointNamespace: receipt.continuation.checkpointNamespace,
            }),
            durableCheckpointAdmission: admission,
            durableCheckpointSourceBinding: captured.binding,
            inspectCheckpointInput: ({ messages }) => {
              const actual = prepared.inspect(messages);
              const files = new Set(captured.binding.files.map((file) => file.fileId));
              const sourceIds = new Set(prepared.projection.sourceMessageIds);
              if (
                actual.fileIds.some((id) => !files.has(id)) ||
                actual.sourceMessageIds.some((id) => !sourceIds.has(id))
              ) {
                throw new Error('Checkpoint input introduced an uncaptured source');
              }
            },
          });
        },
      };
      preparations.set(token, context);
      let initialized;
      let prepared;
      let captured;
      let receipt;
      let admission;
      try {
        // The native hold precedes initializer file accounting as well as source capture.
        receipt = await GenerationJobManager.prepareCheckpointGeneration(
          owner.userId,
          conversationId,
          request,
          claimToken,
          async () => {
            controller.signal.throwIfAborted();
            initialized = await initializeClient({
              req,
              res,
              endpointOption,
              signal: controller.signal,
              foregroundRunId: runId,
              requestBody,
              checkpointPreparation: token,
            });
            prepared = await initialized.client.prepareCheckpointMessage(text, {
              ...messageOptions,
              abortController: controller,
            });
            const projection = new Set(prepared.projection.sourceMessageIds);
            const messages = prepared.history
              .filter((message) => {
                const id = message.messageId ?? message.id;
                return (
                  id !== prepared.currentMessageId &&
                  projection.has(id) &&
                  (message.sourceFileIds?.length > 0 || message.quotes?.length > 0)
                );
              })
              .map((message) => ({
                conversationId: message.conversationId,
                messageId: message.messageId ?? message.id,
                expectedVersion: message.__v ?? null,
              }));
            const identity = fingerprints(initialized.client);
            const namespace = createCheckpointNamespace(owner.userId, owner.tenantId);
            const session = await mongoose.startSession();
            try {
              session.startTransaction();
              controller.signal.throwIfAborted();
              captured = await db.captureCheckpointSources(
                owner,
                {
                  fileIds: [...prepared.projection.fileIds],
                  messages,
                },
                session,
              );
              await session.commitTransaction();
            } finally {
              // No commit replay or source reread can acknowledge an uncertain transaction.
              await session.endSession();
            }
            controller.signal.throwIfAborted();
            return {
              version: 1,
              mode: 'checkpoint-only-v1',
              runId,
              threadId: conversationId,
              checkpointNamespace: namespace,
              ...identity,
              sourceBindingSha256: captured.binding.bindingSha256,
            };
          },
          owner.tenantId,
        );
        controller.signal.throwIfAborted();
        return Object.freeze({
          client: initialized.client,
          initialized,
          generationPreparation: receipt,
          checkpointContinuation: receipt.continuation,
          async bindDispatchedJob(job) {
            if (admission || job.streamId !== conversationId)
              throw new Error('Checkpoint job changed');
            const result = await db.getGenerationAdmission(receipt.input);
            if (
              !result.ok ||
              !result.value ||
              result.value.state !== 'dispatching' ||
              result.value.active !== true ||
              result.value.generationEpoch !== job.createdAt ||
              result.value.segmentId !== job.metadata.providerExecutionId ||
              result.value.requestFingerprint !== request.requestFingerprint ||
              JSON.stringify(result.value.continuation) !== JSON.stringify(receipt.continuation)
            ) {
              throw new Error('Checkpoint dispatch is unconfirmed');
            }
            admission = snapshotGenerationCheckpointAdmission(result.value);
            initialized.bindCheckpointGeneration(job);
            req.removeListener?.('aborted', abort);
            if (job.abortController.signal.aborted) controller.abort();
            else job.abortController.signal.addEventListener('abort', abort, { once: true });
          },
          consume: (opts) => initialized.client.sendPreparedMessage(prepared.token, opts),
        });
      } catch (error) {
        controller.abort();
        req.removeListener?.('aborted', abort);
        if (initialized?.client) disposeClient(initialized.client);
        throw error;
      }
    },
  });
  hosts.add(host);
  return host;
}

module.exports = { createCheckpointRunHost, assertCheckpointRunHost, getCheckpointPreparation };
