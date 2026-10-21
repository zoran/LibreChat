import mongoose, { Schema } from 'mongoose';
import type { StatusUsageReceipt, StatusUsageBucket } from '../types/statusUsage';

const integer = {
  type: Number,
  min: 0,
  max: Number.MAX_SAFE_INTEGER,
  validate: Number.isSafeInteger,
};
const common = {
  _id: { type: String, required: true },
  schemaVersion: { type: Number, enum: [1], required: true },
  scopeId: { type: String, required: true, maxlength: 128 },
  tenantId: { type: String, default: null },
  revision: { ...integer, required: true },
  expiresAt: Date,
};
export const statusUsageReceiptSchema: Schema<StatusUsageReceipt> = new Schema<StatusUsageReceipt>(
  {
    ...common,
    kind: {
      type: String,
      enum: ['activity_hour', 'presence', 'document_publication'],
      required: true,
    },
    createdAtMs: { ...integer, required: true },
    updatedAtMs: { ...integer, required: true },
    userId: String,
    hourStartMs: integer,
    activityBits: Buffer,
    sessionId: String,
    authVersion: integer,
    policyVersion: integer,
    lastVisibleAtMs: integer,
    leaseUntilMs: integer,
    publishedAtMs: integer,
  },
  { strict: 'throw', versionKey: false },
);
statusUsageReceiptSchema.index({ scopeId: 1, tenantId: 1, kind: 1, hourStartMs: 1 });
statusUsageReceiptSchema.index({ scopeId: 1, tenantId: 1, kind: 1, publishedAtMs: 1 });
statusUsageReceiptSchema.index({ scopeId: 1, tenantId: 1, userId: 1, _id: 1 });
statusUsageReceiptSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const gap = {
  type: String,
  enum: [
    'not_instrumented',
    'producer_gap',
    'query_timeout',
    'capacity',
    'purged_activity',
    'owner_conflict',
  ],
};
export const statusUsageBucketSchema: Schema<StatusUsageBucket> = new Schema<StatusUsageBucket>(
  {
    ...common,
    kind: { type: String, enum: ['control', 'hour'], required: true },
    hourStartMs: integer,
    active: integer,
    published: integer,
    acceptAfterMs: integer,
    reservedReceipts: integer,
    usersObservedFromMs: integer,
    documentsObservedFromMs: integer,
    usersGapFromMs: integer,
    documentsGapFromMs: integer,
    usersGap: gap,
    documentsGap: gap,
    collectorOwner: String,
    collectorEpoch: integer,
    collectorUntilMs: integer,
  },
  { strict: 'throw', versionKey: false },
);
statusUsageBucketSchema.index({ scopeId: 1, tenantId: 1, kind: 1, hourStartMs: 1 });
statusUsageBucketSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const sharedFields = [
  '_id',
  'schemaVersion',
  'scopeId',
  'tenantId',
  'kind',
  'revision',
  'expiresAt',
];
statusUsageReceiptSchema.pre('validate', function () {
  const fields = {
    activity_hour: ['userId', 'hourStartMs', 'activityBits'],
    presence: [
      'userId',
      'sessionId',
      'authVersion',
      'policyVersion',
      'lastVisibleAtMs',
      'leaseUntilMs',
    ],
    document_publication: ['publishedAtMs', 'hourStartMs'],
  }[this.kind];
  if (!fields) throw Error('STATUS_USAGE_KIND');
  const value = this.toObject();
  const allowed = new Set([...sharedFields, 'createdAtMs', 'updatedAtMs', ...fields]);
  if (
    Object.keys(value).some((field) => !allowed.has(field)) ||
    fields.some((field) => this.get(field) === undefined) ||
    (this.kind === 'activity_hour' && this.activityBits?.length !== 450) ||
    mongoose.mongo.BSON.calculateObjectSize(value) > 8192
  )
    throw Error('STATUS_USAGE_RECEIPT');
});
statusUsageBucketSchema.pre('validate', function () {
  const fields =
    this.kind === 'hour'
      ? ['hourStartMs', 'active', 'published']
      : [
          'acceptAfterMs',
          'reservedReceipts',
          'usersObservedFromMs',
          'documentsObservedFromMs',
          'usersGapFromMs',
          'documentsGapFromMs',
          'usersGap',
          'documentsGap',
          'collectorOwner',
          'collectorEpoch',
          'collectorUntilMs',
        ];
  const allowed = new Set([...sharedFields, ...fields]);
  const value = this.toObject();
  if (
    Object.keys(value).some((field) => !allowed.has(field)) ||
    mongoose.mongo.BSON.calculateObjectSize(value) > 16384
  )
    throw Error('STATUS_USAGE_BUCKET');
});
