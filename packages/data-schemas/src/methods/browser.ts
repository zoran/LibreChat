import { randomBytes } from 'node:crypto';
import { SystemRoles } from 'librechat-data-provider';
import type { BalanceConfig, IUser } from '~/types';
import { createSessionMethods } from './session';
import { createUserMethods } from './user';
import { hashToken } from '~/crypto';

/** Plain browser-provider projection. Credentials and database internals never cross this port. */
export interface BrowserUser {
  _id: string;
  id: string;
  name: string;
  username: string;
  email: string;
  emailVerified: boolean;
  provider: string;
  role: string;
}

export interface BrowserIdentity {
  user: BrowserUser;
  expiration: Date;
}

export interface BrowserMethods {
  enrollBrowserIdentity: (
    expiration: Date,
    balanceConfig?: BalanceConfig,
  ) => Promise<BrowserIdentity & { credential: string }>;
  findBrowserIdentity: (credential: string) => Promise<BrowserIdentity | null>;
  revokeBrowserIdentity: (credential: string) => Promise<void>;
}

function serialize(user: Partial<IUser>): BrowserUser {
  const id = String(user._id);
  return {
    _id: id,
    id,
    name: user.name ?? '',
    username: user.username ?? '',
    email: user.email ?? '',
    emailVerified: false,
    provider: 'browser',
    role: SystemRoles.USER,
  };
}

/** Browser enrollment owns no separate database: it uses the native User/Balance/Session lifecycle. */
export function createBrowserMethods(mongoose: typeof import('mongoose')): BrowserMethods {
  const users = createUserMethods(mongoose);
  const sessions = createSessionMethods(mongoose);

  async function enrollBrowserIdentity(
    expiration: Date,
    balanceConfig?: BalanceConfig,
  ): Promise<BrowserIdentity & { credential: string }> {
    if (!Number.isFinite(expiration.getTime()) || expiration.getTime() <= Date.now()) {
      throw new Error('Invalid browser session expiration');
    }
    await sessions.ensureSessionIndexes();
    return mongoose.connection.transaction(async (transaction) => {
      const user = await users.createUser(
        {
          name: 'Browser',
          email: `${randomBytes(24).toString('hex')}@browser.invalid`,
          emailVerified: false,
          provider: 'browser',
          role: SystemRoles.USER,
        },
        balanceConfig,
        true,
        true,
        transaction,
      );
      if (user instanceof mongoose.Types.ObjectId) {
        throw new Error('Browser enrollment returned no user');
      }
      const safeUser = serialize(user);
      const credential = `${safeUser.id}.${randomBytes(32).toString('base64url')}`;
      await mongoose.models.Session.create(
        [{ user: safeUser.id, refreshTokenHash: await hashToken(credential), expiration }],
        { session: transaction },
      );
      return { user: safeUser, credential, expiration };
    });
  }

  async function findBrowserIdentity(credential: string): Promise<BrowserIdentity | null> {
    if (!/^[a-f0-9]{24}\.[A-Za-z0-9_-]{43}$/.test(credential)) {
      return null;
    }
    const userId = credential.slice(0, 24);
    const [session, user] = await Promise.all([
      sessions.findSession({ userId, refreshToken: credential }),
      users.getUserById(
        userId,
        '_id name username email provider role tenantId +agentTriggerDeletionStartedAt',
      ),
    ]);
    if (
      !session ||
      !user ||
      user.provider !== 'browser' ||
      user.role !== SystemRoles.USER ||
      user.tenantId ||
      user.agentTriggerDeletionStartedAt
    ) {
      return null;
    }
    return { user: serialize(user), expiration: session.expiration };
  }

  async function revokeBrowserIdentity(credential: string): Promise<void> {
    if (/^[a-f0-9]{24}\.[A-Za-z0-9_-]{43}$/.test(credential)) {
      await sessions.deleteSession({ refreshToken: credential });
    }
  }

  return { enrollBrowserIdentity, findBrowserIdentity, revokeBrowserIdentity };
}
