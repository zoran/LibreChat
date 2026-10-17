import { Schema } from 'mongoose';
import type { GenerationAdmissionRecord } from '~/types/generationAdmission';

/** One durable segment; unresolved receipts have no TTL or lease-based takeover. */
const generationAdmissionSchema: Schema<GenerationAdmissionRecord> =
  new Schema<GenerationAdmissionRecord>(
    {
      tenantId: { type: String, required: true, immutable: true },
      principalId: { type: String, required: true, immutable: true },
      clientRequestId: { type: String, required: true, immutable: true },
      conversationId: { type: String, required: true, immutable: true },
      requestFingerprint: { type: String, required: true, immutable: true },
      protocol: { type: String, required: true, immutable: true },
      ownerInstanceId: { type: String, required: true },
      processBootId: { type: String, required: true },
      generationEpoch: { type: Number, required: true, immutable: true },
      segmentId: { type: String, required: true },
      continuation: {
        type: new Schema(
          {
            version: { type: Number, enum: [1], required: true },
            runId: { type: String, required: true },
            threadId: { type: String, required: true },
            checkpointNamespace: { type: String, required: true },
            graphFingerprint: { type: String, required: true },
            policyFingerprint: { type: String, required: true },
            mode: { type: String, enum: ['checkpoint-only-v1'], required: true },
          },
          { _id: false },
        ),
        immutable: true,
        default: undefined,
      },
      checkpointWriteRevision: { type: Number, default: 0, required: true },
      state: { type: String, enum: ['admitted', 'dispatching', 'settled'], required: true },
      active: { type: Boolean, required: true },
      createdAt: { type: String, required: true, immutable: true },
      predecessors: [
        {
          _id: false,
          ownerInstanceId: String,
          processBootId: String,
          segmentId: String,
          dispatchedAt: String,
          settledAt: String,
          terminal: { outcome: String, evidenceSha256: String },
        },
      ],
      recoveries: [
        {
          _id: false,
          ownerInstanceId: String,
          processBootId: String,
          segmentId: String,
          dispatchedAt: String,
          recoveredAt: String,
          evidence: {
            checkpointWriteRevision: Number,
            terminationEvidenceSha256: String,
            effectsEvidenceSha256: String,
          },
        },
      ],
      dispatchedAt: String,
      settledAt: String,
      terminal: {
        outcome: { type: String, enum: ['completed', 'failed', 'cancelled'] },
        evidenceSha256: String,
      },
    },
    { versionKey: false, writeConcern: { w: 'majority', j: true } },
  );
generationAdmissionSchema.index(
  { tenantId: 1, principalId: 1, clientRequestId: 1 },
  { unique: true, name: 'generation_request' },
);
generationAdmissionSchema.index(
  {
    tenantId: 1,
    principalId: 1,
    'continuation.threadId': 1,
    'continuation.checkpointNamespace': 1,
  },
  {
    unique: true,
    partialFilterExpression: { 'continuation.version': 1 },
    name: 'generation_checkpoint_namespace',
  },
);
generationAdmissionSchema.index(
  { tenantId: 1, principalId: 1, conversationId: 1 },
  {
    unique: true,
    partialFilterExpression: { active: true },
    name: 'generation_active_conversation',
  },
);
export default generationAdmissionSchema;
