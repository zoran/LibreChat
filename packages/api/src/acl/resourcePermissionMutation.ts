/** Private ACL bulk mutation and compensation owner; sessions stay bound to their entry identity. */
import { Types } from 'mongoose';
import { getTransactionSupport, logger, runAfterTransaction } from '@librechat/data-schemas';
import {
  PermissionBits,
  PrincipalModel,
  PrincipalType,
  ResourceType,
} from 'librechat-data-provider';
import type { AllMethods, IAclEntry, AuthContinuationObserver } from '@librechat/data-schemas';
import type { ClientSession, Connection } from 'mongoose';
import type { TPrincipal } from 'librechat-data-provider';
import type { InsightsPermissionChange, InsightsWrittenEntry } from './insightsPermissions';

type BulkPrincipal = Omit<TPrincipal, 'id'> & {
  id?: string | Types.ObjectId;
  memberIds?: string[];
};

export type BulkPermissionUpdateResult = {
  granted: BulkPrincipal[];
  updated: BulkPrincipal[];
  revoked: BulkPrincipal[];
  insightsChanges: InsightsPermissionChange[];
  errors: Array<{ principal: BulkPrincipal; error: string }>;
};

/** One captured binding spans the support original, separate acquired session and every effect. */
function withMutation<T>(
  mongoose: typeof import('mongoose'),
  observer: AuthContinuationObserver | undefined,
  action: (binding: {
    connection: Connection;
    assertCurrent(session?: ClientSession): void;
    track<R>(start: () => Promise<R> | R, session?: ClientSession): Promise<R>;
    write<R>(start: () => Promise<R> | R, session?: ClientSession): Promise<R>;
    acquire<R>(start: () => Promise<R>): Promise<R>;
    cleanup<R>(start: () => Promise<R>, write?: boolean): Promise<R>;
  }) => Promise<T>,
): Promise<T> {
  const run = async () => {
    const connection = mongoose.connection;
    const client = connection?.getClient();
    const db = connection?.db;
    const assertCurrent = (session?: ClientSession) => {
      // MongoDB 6.20.0 exposes client internally; missing or changed identity fails closed.
      if (
        !connection ||
        !client ||
        !db ||
        mongoose.connection !== connection ||
        connection.getClient() !== client ||
        connection.db !== db ||
        (session && (session as unknown as { client?: unknown }).client !== client)
      ) {
        observer?.markUncertain();
        throw new Error('ACL original connection or session identity changed');
      }
    };
    const effect = async <R>(
      start: () => Promise<R> | R,
      write: boolean,
      session?: ClientSession,
      mode: 'effect' | 'acquire' | 'cleanup' = 'effect',
    ): Promise<R> => {
      const invoke = async () => {
        if (mode !== 'cleanup') assertCurrent(session);
        const result = await start();
        if (mode === 'effect') assertCurrent(session);
        return result;
      };
      try {
        if (!observer) return await invoke();
        if (write) return await observer.write(invoke);
        return await observer.track(invoke);
      } catch (error) {
        observer?.markUncertain();
        throw error;
      }
    };
    assertCurrent();
    return action({
      connection,
      assertCurrent,
      track: (start, session) => effect(start, false, session),
      write: (start, session) => effect(start, true, session),
      acquire: (start) => effect(start, false, undefined, 'acquire'),
      cleanup: (start, write = false) => effect(start, write, undefined, 'cleanup'),
    });
  };
  return observer ? observer.track(run) : run();
}

export function bulkUpdateResourcePermissions(
  mongoose: typeof import('mongoose'),
  dbMethods: AllMethods,
  {
    resourceType,
    resourceId,
    updatedPrincipals = [],
    revokedPrincipals = [],
    grantedBy,
    session,
    maxWriteAttempts,
    observer,
  }: {
    resourceType: ResourceType;
    resourceId: string | Types.ObjectId;
    updatedPrincipals?: BulkPrincipal[];
    revokedPrincipals?: BulkPrincipal[];
    grantedBy: string | Types.ObjectId;
    session?: ClientSession;
    maxWriteAttempts?: number;
    observer?: AuthContinuationObserver;
  },
): Promise<BulkPermissionUpdateResult> {
  return withMutation(mongoose, observer, async (binding) => {
    const supportsTransactions = await binding.track(() =>
      getTransactionSupport(mongoose, null, observer),
    );
    // This owner has no proved clean-negative classifier. A failed original cannot authorize writes.
    if (!supportsTransactions) throw new Error('Transaction original remains unconfirmed');
    let localSession = session;
    let shouldEndSession = false;
    let startAttempted = false;
    let failed = false;
    let failure: unknown;
    let results!: BulkPermissionUpdateResult;

    try {
      if (!Array.isArray(updatedPrincipals)) {
        throw new Error('updatedPrincipals must be an array');
      }
      if (!Array.isArray(revokedPrincipals)) {
        throw new Error('revokedPrincipals must be an array');
      }
      if (!resourceId || !Types.ObjectId.isValid(resourceId)) {
        throw new Error(`Invalid resource ID: ${resourceId}`);
      }

      if (!localSession && supportsTransactions) {
        localSession = await binding.acquire(() => binding.connection.startSession());
        shouldEndSession = true;
        binding.assertCurrent(localSession);
        startAttempted = true;
        await binding.write(() => localSession!.startTransaction(), localSession);
      }
      binding.assertCurrent(localSession);
      // The external transaction owner has not qualified its eventual disposition.
      if (session) observer?.markUncertain();
      const sessionOptions = localSession ? { session: localSession } : {};
      const [roleOutcome, entriesOutcome] = await Promise.allSettled([
        binding.track(() => dbMethods.findRolesByResourceType(resourceType), localSession),
        resourceType === ResourceType.AGENT
          ? binding.track(
              () => dbMethods.findEntriesByResource(resourceType, resourceId, localSession),
              localSession,
            )
          : Promise.resolve([]),
      ]);
      // Join every launched lookup before cleanup, even if the first original failed.
      if (roleOutcome.status === 'rejected') throw roleOutcome.reason;
      if (entriesOutcome.status === 'rejected') throw entriesOutcome.reason;
      const roles = roleOutcome.value;
      const currentEntries = entriesOutcome.value;
      const rolesMap = new Map(roles.map((role) => [role.accessRoleId, role]));
      results = {
        granted: [],
        updated: [],
        revoked: [],
        insightsChanges: [],
        errors: [],
      };
      const bulkWrites: Parameters<AllMethods['bulkWriteAclEntries']>[0] = [];
      /** Role-only edits go through the atomic guarded write, not this batch. */
      const roleBitsWrites: Parameters<AllMethods['replaceRoleBits']>[0] = [];
      const insightsChangesByBulkWriteIndex = new Map<number, InsightsPermissionChange>();

      const updatedPrincipalKey = (principal: BulkPrincipal | null | undefined) => {
        if (!principal?.type) return null;
        if (principal.type === PrincipalType.PUBLIC) return `${PrincipalType.PUBLIC}:null`;
        return principal.id == null ? null : `${principal.type}:${principal.id}`;
      };
      const lastUpdateIndexByPrincipal = new Map<string, number>();
      updatedPrincipals.forEach((principal, index) => {
        const key = updatedPrincipalKey(principal);
        if (key != null) lastUpdateIndexByPrincipal.set(key, index);
      });
      const effectiveUpdatedPrincipals = updatedPrincipals.filter((principal, index) => {
        const key = updatedPrincipalKey(principal);
        return key == null || lastUpdateIndexByPrincipal.get(key) === index;
      });

      /**
       * A grant wins when the same non-public principal is also in the revoke list. The client can
       * produce both forms when `id` and `idOnTheSource` differ, and applying the revoke would remove
       * the permission just written. Public access is excluded because an explicit disable must win.
       */
      const grantedPrincipalKeys = new Set<string>();
      const principalKey = (principal: BulkPrincipal) => `${principal.type}:${principal.id}`;
      const queryPrincipalId = (principal: BulkPrincipal) => {
        if (principal.type === PrincipalType.ROLE) {
          if (typeof principal.id !== 'string' || principal.id.trim().length === 0) {
            throw new Error(`Invalid role ID: ${principal.id}`);
          }
          return principal.id;
        }
        const id = principal.id?.toString();
        if (!id || !Types.ObjectId.isValid(id)) {
          throw new Error(`Invalid principal ID: ${principal.id}`);
        }
        return new Types.ObjectId(id);
      };
      const currentEntriesByPrincipal = new Map<string, IAclEntry>();
      for (const entry of currentEntries) {
        const key = `${entry.principalType}:${entry.principalId == null ? 'null' : entry.principalId.toString()}`;
        const current = currentEntriesByPrincipal.get(key);
        const entryHasInsights =
          (entry.permBits & PermissionBits.VIEW_INSIGHTS) === PermissionBits.VIEW_INSIGHTS;
        const currentHasInsights =
          current != null &&
          (current.permBits & PermissionBits.VIEW_INSIGHTS) === PermissionBits.VIEW_INSIGHTS;
        if (!current || (entryHasInsights && !currentHasInsights)) {
          currentEntriesByPrincipal.set(key, entry);
        }
      }

      for (const principal of effectiveUpdatedPrincipals) {
        try {
          if (!principal?.accessRoleId) {
            results.errors.push({
              principal,
              error: 'accessRoleId is required for updated principals',
            });
            continue;
          }
          const role = rolesMap.get(principal.accessRoleId);
          if (!role) {
            results.errors.push({
              principal,
              error: `Role ${principal.accessRoleId} not found`,
            });
            continue;
          }

          const query: Record<string, unknown> = {
            principalType: principal.type,
            resourceType,
            resourceId,
          };
          if (principal.type !== PrincipalType.PUBLIC) {
            query.principalId = queryPrincipalId(principal);
          }

          const existingEntry = currentEntriesByPrincipal.get(
            `${principal.type}:${principal.type === PrincipalType.PUBLIC ? 'null' : principal.id}`,
          );
          const hadInsights =
            ((existingEntry?.permBits ?? 0) & PermissionBits.VIEW_INSIGHTS) ===
            PermissionBits.VIEW_INSIGHTS;
          const roleCanView = (role.permBits & PermissionBits.VIEW) === PermissionBits.VIEW;
          const requestedInsights =
            typeof principal.viewInsights === 'boolean' ? principal.viewInsights : undefined;
          const preserveInsights =
            resourceType === ResourceType.AGENT &&
            principal.type !== PrincipalType.PUBLIC &&
            roleCanView &&
            requestedInsights === undefined;
          const wantsInsights =
            resourceType === ResourceType.AGENT &&
            principal.type !== PrincipalType.PUBLIC &&
            roleCanView &&
            (requestedInsights === undefined ? hadInsights : requestedInsights);
          const permBits = wantsInsights
            ? role.permBits | PermissionBits.VIEW_INSIGHTS
            : role.permBits & ~PermissionBits.VIEW_INSIGHTS;
          const grantedAt = new Date();
          const principalModelMap: Partial<Record<PrincipalType, PrincipalModel>> = {
            [PrincipalType.USER]: PrincipalModel.USER,
            [PrincipalType.GROUP]: PrincipalModel.GROUP,
            [PrincipalType.ROLE]: PrincipalModel.ROLE,
          };
          const update = {
            $set: {
              ...(!preserveInsights && { permBits }),
              roleId: role._id,
              grantedBy,
              grantedAt,
            },
            $setOnInsert: {
              principalType: principal.type,
              resourceType,
              resourceId,
              ...(principal.type !== PrincipalType.PUBLIC && {
                principalId: queryPrincipalId(principal),
                principalModel: principalModelMap[principal.type],
              }),
            },
          };
          const bulkWriteIndex = bulkWrites.length;
          if (preserveInsights) {
            roleBitsWrites.push({
              filter: query,
              insert: update.$setOnInsert,
              roleBits: role.permBits,
              metadata: update.$set,
            });
          } else {
            bulkWrites.push({
              updateMany: { filter: query, update, upsert: true },
            });
          }
          results.granted.push({
            type: principal.type,
            id: principal.id,
            name: principal.name,
            email: principal.email,
            source: principal.source,
            avatar: principal.avatar,
            description: principal.description,
            idOnTheSource: principal.idOnTheSource,
            accessRoleId: principal.accessRoleId,
            memberCount: principal.memberCount,
            memberIds: principal.memberIds,
            ...(resourceType === ResourceType.AGENT ? { viewInsights: wantsInsights } : {}),
          });
          if (hadInsights !== wantsInsights) {
            const writtenEntry: InsightsWrittenEntry = {
              permBits,
              roleId: role._id,
              grantedBy,
              grantedAt,
            };
            const change: InsightsPermissionChange = {
              action: wantsInsights ? 'assigned' : 'removed',
              previousEntry: existingEntry ?? null,
              writtenEntry,
              principal: { type: principal.type, id: principal.id, name: principal.name },
            };
            results.insightsChanges.push(change);
            insightsChangesByBulkWriteIndex.set(bulkWriteIndex, change);
          }
          if (principal.type !== PrincipalType.PUBLIC) {
            grantedPrincipalKeys.add(principalKey(principal));
          }
        } catch (error) {
          results.errors.push({
            principal,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (roleBitsWrites.length > 0) {
        await binding.write(
          () =>
            dbMethods.replaceRoleBits(roleBitsWrites, {
              ...sessionOptions,
              maxAttempts: maxWriteAttempts,
            }),
          localSession,
        );
      }

      if (bulkWrites.length > 0) {
        const bulkWriteResult = await binding.write(
          () => dbMethods.bulkWriteAclEntries(bulkWrites, sessionOptions),
          localSession,
        );
        for (const [writeIndex, change] of insightsChangesByBulkWriteIndex) {
          if (bulkWriteResult.upsertedIds?.[writeIndex] && change.previousEntry) {
            change.previousEntry = null;
          }
        }
      }

      for (const principal of revokedPrincipals) {
        try {
          if (
            principal?.type !== PrincipalType.PUBLIC &&
            principal != null &&
            grantedPrincipalKeys.has(principalKey(principal))
          ) {
            continue;
          }
          const query: Record<string, unknown> = {
            principalType: principal.type,
            resourceType,
            resourceId,
          };
          if (principal.type !== PrincipalType.PUBLIC) {
            query.principalId = queryPrincipalId(principal);
          }
          const deleteResult = await binding.write(
            () => dbMethods.deleteAclEntries(query, sessionOptions),
            localSession,
          );
          const existingEntry = currentEntriesByPrincipal.get(
            `${principal.type}:${principal.type === PrincipalType.PUBLIC ? 'null' : principal.id}`,
          );
          results.revoked.push({
            type: principal.type,
            id: principal.id,
            name: principal.name,
            email: principal.email,
            source: principal.source,
            avatar: principal.avatar,
            description: principal.description,
            idOnTheSource: principal.idOnTheSource,
            memberCount: principal.memberCount,
          });
          if (
            resourceType === ResourceType.AGENT &&
            deleteResult.deletedCount > 0 &&
            existingEntry &&
            (existingEntry.permBits & PermissionBits.VIEW_INSIGHTS) === PermissionBits.VIEW_INSIGHTS
          ) {
            results.insightsChanges.push({
              action: 'removed',
              previousEntry: existingEntry,
              writtenEntry: null,
              principal: { type: principal.type, id: principal.id, name: principal.name },
            });
          }
        } catch (error) {
          results.errors.push({
            principal,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (shouldEndSession && supportsTransactions) {
        await binding.write(() => localSession!.commitTransaction(), localSession);
      }
      if (resourceType === ResourceType.PROMPTGROUP) {
        await runAfterTransaction(
          localSession,
          () =>
            binding.write(
              () => dbMethods.invalidatePromptGroupAccessContext(observer),
              localSession,
            ),
          observer,
        );
      }
    } catch (error) {
      failed = true;
      failure = error;
      if (shouldEndSession && startAttempted) {
        try {
          await binding.cleanup(() => localSession!.abortTransaction(), true);
        } catch (transactionError) {
          logger.error(
            '[AccessControlService.bulkUpdateResourcePermissions] Error aborting transaction:',
            transactionError,
          );
        }
      }
      logger.error(
        `[AccessControlService.bulkUpdateResourcePermissions] Error: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (shouldEndSession && localSession) {
        try {
          await binding.cleanup(() => localSession!.endSession());
          binding.assertCurrent(localSession);
        } catch (endError) {
          if (!failed) {
            failed = true;
            failure = endError;
          } else {
            logger.error(
              '[AccessControlService.bulkUpdateResourcePermissions] Error ending session:',
              endError,
            );
          }
        }
      }
    }
    if (failed) throw failure;
    return results;
  });
}

export function restoreInsightsPermissionChanges(
  mongoose: typeof import('mongoose'),
  dbMethods: AllMethods,
  {
    resourceType,
    resourceId,
    changes = [],
    observer,
  }: {
    resourceType: ResourceType;
    resourceId: string | Types.ObjectId;
    changes?: InsightsPermissionChange[];
    observer?: AuthContinuationObserver;
  },
): Promise<void> {
  return withMutation(mongoose, observer, async (binding) => {
    const operations: Parameters<AllMethods['bulkWriteAclEntries']>[0] = changes.flatMap(
      (change): Parameters<AllMethods['bulkWriteAclEntries']>[0] => {
        const filter: Record<string, unknown> = {
          principalType: change.principal.type,
          resourceType,
          resourceId,
        };
        if (change.principal.type !== PrincipalType.PUBLIC) {
          if (change.principal.type === PrincipalType.ROLE) {
            filter.principalId = change.principal.id;
          } else {
            const id = change.principal.id?.toString();
            if (!id || !Types.ObjectId.isValid(id)) {
              throw new Error(`Invalid principal ID: ${change.principal.id}`);
            }
            filter.principalId = new Types.ObjectId(id);
          }
        }
        if (change.previousEntry && change.writtenEntry) {
          return [
            {
              replaceOne: {
                filter: { _id: change.previousEntry._id, ...change.writtenEntry },
                replacement: change.previousEntry,
                timestamps: false,
              },
            },
            {
              updateMany: {
                filter: {
                  ...filter,
                  ...change.writtenEntry,
                  _id: { $ne: change.previousEntry._id },
                },
                update: {
                  $set: {
                    permBits: change.previousEntry.permBits,
                    roleId: change.previousEntry.roleId,
                    grantedBy: change.previousEntry.grantedBy,
                    grantedAt: change.previousEntry.grantedAt,
                  },
                },
                timestamps: false,
              },
            },
          ];
        }
        if (change.previousEntry) {
          return [
            {
              updateOne: {
                filter,
                update: { $setOnInsert: change.previousEntry },
                upsert: true,
                timestamps: false,
              },
            },
          ];
        }
        return [
          {
            deleteMany: {
              filter: { ...filter, ...change.writtenEntry },
            },
          },
        ];
      },
    );
    if (operations.length > 0) {
      await binding.write(() => dbMethods.bulkWriteAclEntries(operations));
    }
  });
}
