import { timingSafeEqual } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import type {
  EmailCodeRepository,
  EmailCodeRepositoryError,
  EmailCodeChallenge,
  EmailCodeIdentity,
  EmailCodeGrant,
} from '~/types/emailCode';
import type { ISession } from '~/types/session';
import type { IUser } from '~/types/user';
import { EMAIL_CODE_IDLE_MS, EMAIL_CODE_ABSOLUTE_MS } from '../emailCodePolicy';
import { emailCodeProfileName } from '../utils/emailCodeProfile';
import { createEmailCodeModels } from '~/models/emailCode';
import { tenantStorage } from '~/config/tenantContext';
import { createUserMethods } from './user';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const READ_TIMEOUT_MS = 2_000;

export class EmailCodeStoreError extends Error {
  constructor(public code: EmailCodeRepositoryError) {
    super(code);
  }
}

type Budget = {
  _id: string;
  sends: number[];
  failures: number[];
  requests: number[];
  active: Array<{ key: string; expiresAt: number }>;
  expiresAt: Date;
};
const after = (times: number[], cutoff: number) => times.filter((time) => time > cutoff);
const same = (a: string, b: string) =>
  /^[a-f0-9]{64}$/.test(a) &&
  /^[a-f0-9]{64}$/.test(b) &&
  timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));

/** Native User/Session composition and one transactional challenge authority across replicas. */
export function createEmailCodeMethods(
  mongoose: typeof import('mongoose'),
  deps: {
    reconcileConfiguredAdministrators?: (tenantId: string, session: ClientSession) => Promise<void>;
  } = {},
): EmailCodeRepository {
  const { EmailCodeChallenge: Challenge, EmailCodeBudget: Counter } =
    createEmailCodeModels(mongoose);
  const users = createUserMethods(mongoose);
  const scoped = <T>(tenantId: string, action: () => Promise<T>) => {
    if (!tenantId || tenantId === '__SYSTEM__') throw new Error('Trusted email tenant required');
    return tenantStorage.run({ ...tenantStorage.getStore(), tenantId }, action);
  };
  const transaction = <T>(action: (session: ClientSession) => Promise<T>) =>
    mongoose.connection.transaction(action, {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
      readPreference: 'primary',
      maxCommitTimeMS: READ_TIMEOUT_MS,
    });
  let indexes: Promise<unknown> | undefined;
  const ensureIndexes = () =>
    (indexes ??= Promise.all([
      Challenge.createIndexes(),
      Counter.createIndexes(),
      mongoose.models.User.createIndexes(),
      mongoose.models.Session.createIndexes(),
    ]).catch((error) => {
      indexes = undefined;
      throw error;
    }));

  async function budget(key: string, now: number, session: ClientSession): Promise<Budget> {
    const existing = await Counter.findById(key).session(session).lean();
    const b = existing as unknown as Budget | null;
    return {
      _id: key,
      sends: after(b?.sends ?? [], now - DAY),
      failures: after(b?.failures ?? [], now - HOUR),
      requests: after(b?.requests ?? [], now - HOUR),
      active: (b?.active ?? []).filter((item) => item.expiresAt > now),
      expiresAt: new Date(now + DAY),
    };
  }
  async function saveBudget(b: Budget, session: ClientSession) {
    await Counter.replaceOne({ _id: b._id }, b, { upsert: true, session });
  }
  const mailboxId = (c: EmailCodeChallenge) => `mailbox:${c.tenantId}:${c.mailboxKey}`;
  const inflightId = (id: string, generation: number) => `${id}:${generation}`;

  async function reserveEmailCodeAttempt(
    input: Parameters<EmailCodeRepository['reserveEmailCodeAttempt']>[0],
  ) {
    await ensureIndexes();
    const { challenge: c, previousGeneration, now } = input;
    await transaction(async (session) => {
      const time = Math.max(now.getTime(), Date.now());
      const current = await Challenge.findOne({ _id: c._id, tenantId: c.tenantId })
        .session(session)
        .lean<EmailCodeChallenge>();
      if (previousGeneration != null) {
        if (
          !current ||
          current.generation !== previousGeneration ||
          current.consumedAt ||
          !same(current.nonceHash, c.nonceHash) ||
          current.mailboxKey !== c.mailboxKey ||
          current.resendAt.getTime() > time ||
          current.expiresAt.getTime() <= time
        ) {
          throw new EmailCodeStoreError('EMAIL_CODE_INVALID');
        }
      } else if (current) {
        throw new EmailCodeStoreError('EMAIL_CODE_INVALID');
      }
      const mailbox = await budget(mailboxId(c), time, session);
      const global = await budget('global:sends', time, session);
      const others = mailbox.active.filter((item) => item.key !== c._id);
      if (
        others.length >= 3 ||
        mailbox.failures.length >= 20 ||
        mailbox.sends.some((sent) => sent > time - MINUTE) ||
        after(mailbox.sends, time - 15 * MINUTE).length >= 5 ||
        after(mailbox.sends, time - HOUR).length >= 10 ||
        mailbox.sends.length >= 20 ||
        after(global.sends, time - MINUTE).length >= 600 ||
        after(global.sends, time - HOUR).length >= 10_000 ||
        global.active.length >= 20
      ) {
        throw new EmailCodeStoreError('EMAIL_CODE_THROTTLED');
      }
      mailbox.sends.push(time);
      mailbox.active = [...others, { key: c._id, expiresAt: c.expiresAt.getTime() }];
      global.sends = [...after(global.sends, time - HOUR), time];
      // Sender must have a hard deadline shorter than this lease, including socket termination.
      global.active.push({
        key: inflightId(c._id, c.generation),
        expiresAt: c.expiresAt.getTime(),
      });
      await saveBudget(mailbox, session);
      await saveBudget(global, session);
      await Challenge.replaceOne({ _id: c._id, tenantId: c.tenantId }, c, {
        upsert: previousGeneration == null,
        session,
      });
    });
  }

  async function finishEmailCodeSend(attemptId: string, generation: number, accepted: boolean) {
    await transaction(async (session) => {
      const now = Date.now();
      const global = await budget('global:sends', now, session);
      global.active = global.active.filter(
        (item) => item.key !== inflightId(attemptId, generation),
      );
      await saveBudget(global, session);
      await Challenge.updateOne(
        {
          _id: attemptId,
          generation,
          consumedAt: { $exists: false },
          expiresAt: { $gt: new Date(now) },
        },
        { $set: { accepted } },
        { session },
      );
    });
  }

  async function getEmailCodeChallenge(attemptId: string, tenantId: string) {
    return Challenge.findOne({ _id: attemptId, tenantId })
      .read('primary')
      .maxTimeMS(READ_TIMEOUT_MS)
      .lean<EmailCodeChallenge>();
  }

  async function consumeEmailCodeNetwork(key: string, now: Date) {
    await ensureIndexes();
    await transaction(async (session) => {
      const b = await budget(`network:${key}`, now.getTime(), session);
      if (
        b.requests.length >= 60_000 ||
        after(b.requests, now.getTime() - MINUTE).length >= 2_400
      ) {
        throw new EmailCodeStoreError('EMAIL_CODE_THROTTLED');
      }
      b.requests.push(now.getTime());
      await saveBudget(b, session);
    });
  }

  function identity(user: Partial<IUser>, session: Partial<ISession>): EmailCodeIdentity {
    const userId = String(user._id);
    return {
      user: {
        id: userId,
        _id: userId,
        email: user.email!,
        emailVerified: true,
        name: user.name ?? '',
        username: user.username ?? '',
        provider: 'email_code',
        role: user.role ?? 'USER',
        tenantId: session.tenantId!,
      },
      grant: {
        sessionId: String(session._id),
        userId,
        tenantId: session.tenantId!,
        authVersion: session.authVersion!,
        policyVersion: session.authPolicyVersion!,
        refreshGeneration: session.refreshGeneration!,
        createdAt: session.authCreatedAt!.getTime(),
        absoluteExpiresAt: session.expiration!.getTime(),
        idleExpiresAt: session.idleExpiresAt!.getTime(),
      },
    };
  }

  async function redeemEmailCode(input: Parameters<EmailCodeRepository['redeemEmailCode']>[0]) {
    return scoped(input.tenantId, async () => {
      const result = await transaction(
        async (session): Promise<EmailCodeIdentity | EmailCodeRepositoryError> => {
          const c = await Challenge.findOne({ _id: input.attemptId, tenantId: input.tenantId })
            .session(session)
            .lean<EmailCodeChallenge>();
          const time = Math.max(input.now.getTime(), Date.now());
          const issuedAt = new Date(time);
          if (
            !c ||
            !same(c.nonceHash, input.nonceHash) ||
            c.consumedAt ||
            !c.accepted ||
            c.expiresAt.getTime() <= time ||
            c.failures >= 5
          )
            return 'EMAIL_CODE_INVALID';
          const mailbox = await budget(mailboxId(c), time, session);
          if (mailbox.failures.length >= 20) return 'EMAIL_CODE_THROTTLED';
          if (c.generation !== input.generation || !same(c.verifier, input.verifier)) {
            mailbox.failures.push(time);
            await saveBudget(mailbox, session);
            await Challenge.updateOne(
              { _id: c._id, generation: c.generation },
              { $inc: { failures: 1 } },
              { session },
            );
            return 'EMAIL_CODE_INVALID'; // Commit failed-guess accounting, then reject outside transaction.
          }
          let user = await mongoose.models.User.findOne({ email: c.email, tenantId: c.tenantId })
            .select('+agentTriggerDeletionStartedAt')
            .session(session)
            .lean<IUser>();
          if (
            user &&
            (user.provider !== 'email_code' ||
              !user.emailVerified ||
              user.authDisabled ||
              user.agentTriggerDeletionStartedAt)
          ) {
            return 'EMAIL_CODE_ACCOUNT_CONFLICT';
          }
          if (!user) {
            user = (await users.createUser(
              {
                email: c.email,
                name: emailCodeProfileName(c.email),
                emailVerified: true,
                provider: 'email_code',
                role: 'USER',
                tenantId: c.tenantId,
                authVersion: 0,
              },
              input.balance,
              true,
              true,
              session,
            )) as IUser;
          }
          if (!user.name?.trim()) {
            const updated = await mongoose.models.User.findOneAndUpdate(
              {
                _id: user._id,
                email: c.email,
                tenantId: c.tenantId,
                provider: 'email_code',
                $or: [{ name: { $exists: false } }, { name: null }, { name: /^\s*$/ }],
              },
              { $set: { name: emailCodeProfileName(c.email) } },
              { session, new: true },
            ).lean<IUser>();
            if (updated) user = updated;
          }
          // Only a successfully verified identity can materialize a configured grant.
          // A policy/audit failure aborts user, session and challenge consumption together.
          await deps.reconcileConfiguredAdministrators?.(c.tenantId, session);
          const grant = (
            await mongoose.models.Session.create(
              [
                {
                  _id: new mongoose.Types.ObjectId(input.sessionId),
                  user: user._id,
                  tenantId: c.tenantId,
                  authMethod: 'email_code',
                  authPolicyVersion: input.policyVersion,
                  authVersion: user.authVersion ?? 0,
                  refreshGeneration: 0,
                  authCreatedAt: issuedAt,
                  expiration: new Date(time + EMAIL_CODE_ABSOLUTE_MS),
                  idleExpiresAt: new Date(time + EMAIL_CODE_IDLE_MS),
                  refreshTokenHash: input.refreshTokenHash,
                },
              ],
              { session },
            )
          )[0] as ISession;
          await Challenge.updateOne(
            { _id: c._id, generation: c.generation, consumedAt: { $exists: false } },
            { $set: { consumedAt: issuedAt, accepted: false }, $unset: { verifier: '' } },
            { session },
          );
          mailbox.active = mailbox.active.filter((item) => item.key !== c._id);
          await saveBudget(mailbox, session);
          return identity(user, grant);
        },
      );
      if (typeof result === 'string') throw new EmailCodeStoreError(result);
      return result;
    });
  }

  async function readEmailCodeIdentity(
    sessionId: string,
    tenantId: string,
    currentRefresh?: Parameters<EmailCodeRepository['readEmailCodeIdentity']>[2],
  ) {
    if (!/^[a-f0-9]{24}$/.test(sessionId)) return null;
    if (
      currentRefresh !== undefined &&
      (!currentRefresh ||
        typeof currentRefresh.refreshTokenHash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(currentRefresh.refreshTokenHash) ||
        !Number.isSafeInteger(currentRefresh.refreshGeneration) ||
        currentRefresh.refreshGeneration < 0)
    )
      return null;
    return scoped(tenantId, async () => {
      const session = await mongoose.models.Session.findOne({
        _id: sessionId,
        tenantId,
        authMethod: 'email_code',
        ...(currentRefresh && {
          refreshTokenHash: currentRefresh.refreshTokenHash,
          refreshGeneration: currentRefresh.refreshGeneration,
        }),
      })
        .read('primary')
        .readConcern('linearizable')
        .maxTimeMS(READ_TIMEOUT_MS)
        .lean<ISession>();
      const now = Date.now();
      if (
        !session ||
        session.revokedAt ||
        !session.authCreatedAt ||
        !session.idleExpiresAt ||
        session.expiration.getTime() <= now ||
        session.idleExpiresAt.getTime() <= now ||
        !Number.isSafeInteger(session.authVersion) ||
        !Number.isSafeInteger(session.authPolicyVersion) ||
        !Number.isSafeInteger(session.refreshGeneration)
      )
        return null;
      const user = await mongoose.models.User.findOne({ _id: session.user, tenantId })
        .select('+agentTriggerDeletionStartedAt')
        .read('primary')
        .readConcern('linearizable')
        .maxTimeMS(READ_TIMEOUT_MS)
        .lean<IUser>();
      if (
        !user ||
        user.provider !== 'email_code' ||
        !user.emailVerified ||
        user.authDisabled ||
        user.agentTriggerDeletionStartedAt ||
        (user.authVersion ?? 0) !== session.authVersion ||
        (user.credentialsChangedAt && user.credentialsChangedAt >= session.authCreatedAt) ||
        (user.twoFactorEnrolledAt && user.twoFactorEnrolledAt > session.authCreatedAt) ||
        Math.min(session.expiration.getTime(), session.idleExpiresAt.getTime()) <= Date.now()
      )
        return null;
      return identity(user, session);
    });
  }

  function liveGrant(grant: EmailCodeGrant, now: Date) {
    return {
      _id: grant.sessionId,
      user: grant.userId,
      tenantId: grant.tenantId,
      authMethod: 'email_code',
      authVersion: grant.authVersion,
      authPolicyVersion: grant.policyVersion,
      revokedAt: { $exists: false },
      expiration: { $gt: now },
      idleExpiresAt: { $gt: now },
    };
  }

  async function rotateEmailCodeRefresh(
    input: Parameters<EmailCodeRepository['rotateEmailCodeRefresh']>[0],
  ) {
    return scoped(input.grant.tenantId, async () => {
      const result = await mongoose.models.Session.updateOne(
        {
          ...liveGrant(input.grant, input.now),
          refreshGeneration: input.grant.refreshGeneration,
          refreshTokenHash: input.oldHash,
        },
        { $set: { refreshTokenHash: input.newHash }, $inc: { refreshGeneration: 1 } },
        { writeConcern: { w: 'majority' }, maxTimeMS: READ_TIMEOUT_MS },
      );
      if (result.modifiedCount !== 1) throw new EmailCodeStoreError('REFRESH_REPLACED');
    });
  }

  async function revokeEmailCodeSession(sessionId: string, userId: string, tenantId: string) {
    await scoped(tenantId, async () =>
      mongoose.models.Session.updateOne(
        { _id: sessionId, user: userId, tenantId, authMethod: 'email_code' },
        { $set: { revokedAt: new Date() } },
        { writeConcern: { w: 'majority' }, maxTimeMS: READ_TIMEOUT_MS },
      ).exec(),
    );
  }
  async function revokeEmailCodeAccount(userId: string, tenantId: string) {
    await scoped(tenantId, async () =>
      mongoose.models.User.updateOne(
        { _id: userId, tenantId, provider: 'email_code' },
        { $inc: { authVersion: 1 }, $set: { credentialsChangedAt: new Date() } },
        { writeConcern: { w: 'majority' }, maxTimeMS: READ_TIMEOUT_MS },
      ).exec(),
    );
  }
  async function touchEmailCodeSession(grant: EmailCodeGrant, now: Date) {
    await scoped(grant.tenantId, async () => {
      await mongoose.models.Session.updateOne(
        liveGrant(grant, now),
        {
          $max: {
            idleExpiresAt: new Date(
              Math.min(now.getTime() + EMAIL_CODE_IDLE_MS, grant.absoluteExpiresAt),
            ),
          },
        },
        { writeConcern: { w: 'majority' }, maxTimeMS: READ_TIMEOUT_MS },
      );
    });
  }
  return {
    reserveEmailCodeAttempt,
    finishEmailCodeSend,
    getEmailCodeChallenge,
    consumeEmailCodeNetwork,
    redeemEmailCode,
    readEmailCodeIdentity,
    rotateEmailCodeRefresh,
    revokeEmailCodeSession,
    revokeEmailCodeAccount,
    touchEmailCodeSession,
  };
}
