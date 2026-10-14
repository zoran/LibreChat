import mongoose, { Schema } from 'mongoose';
import { ISession } from '~/types';

const sessionSchema: Schema<ISession> = new Schema({
  refreshTokenHash: {
    type: String,
    required: true,
  },
  expiration: {
    type: Date,
    required: true,
    expires: 0,
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  tenantId: {
    type: String,
    index: true,
  },
  authMethod: { type: String },
  authPolicyVersion: { type: Number },
  authVersion: { type: Number },
  refreshGeneration: { type: Number },
  authCreatedAt: { type: Date },
  idleExpiresAt: { type: Date },
  revokedAt: { type: Date },
});

sessionSchema.index({ user: 1, refreshTokenHash: 1 }, { unique: true });

export default sessionSchema;
