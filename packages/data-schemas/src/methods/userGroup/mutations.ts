/** Group writes and Entra synchronization; shared invalidation and reads are captured once. */
import { Types } from 'mongoose';
import type { Model, ClientSession } from 'mongoose';
import type { AuthContinuationObserver } from '../authPersistence';
import type { UserGroupCache } from './cache';
import type { UserGroupReads } from './reads';
import type { IGroup, IUser } from '~/types';
import { observeAuthPersistence } from '../authPersistence';
import { runAfterTransaction } from './cache';

/** Extracts member ids referenced by a group update; indeterminate when they cannot be enumerated. */
function collectMemberIdsFromGroupUpdate(update: Record<string, unknown>): {
  memberIds: string[];
  indeterminate: boolean;
} {
  if (Array.isArray(update)) {
    /** Aggregation-pipeline updates: affected members cannot be statically enumerated. */
    return { memberIds: [], indeterminate: true };
  }
  const memberIds: string[] = [];

  const collect = (value: unknown): boolean => {
    if (typeof value === 'string') {
      memberIds.push(value);
      return true;
    }
    if (value instanceof Types.ObjectId) {
      memberIds.push(value.toString());
      return true;
    }
    if (Array.isArray(value)) {
      return value.every(collect);
    }
    if (value !== null && typeof value === 'object') {
      const modifiers = value as { $each?: unknown; $in?: unknown };
      if (Array.isArray(modifiers.$each)) {
        return modifiers.$each.every(collect);
      }
      if (Array.isArray(modifiers.$in)) {
        return modifiers.$in.every(collect);
      }
    }
    return false;
  };

  let indeterminate = false;
  for (const [operator, operand] of Object.entries(update)) {
    const touchesMembers =
      operator === 'memberIds' ||
      (operand !== null &&
        typeof operand === 'object' &&
        'memberIds' in (operand as Record<string, unknown>));
    if (!touchesMembers) {
      continue;
    }
    if (operator === '$addToSet' || operator === '$push' || operator === '$pull') {
      indeterminate = !collect((operand as Record<string, unknown>).memberIds) || indeterminate;
    } else if (operator === '$pullAll') {
      const values = (operand as Record<string, unknown>).memberIds;
      indeterminate = !Array.isArray(values) || !values.every(collect) || indeterminate;
    } else {
      /** Wholesale replacement ($set, $unset, direct assignment): affected members are unknown. */
      indeterminate = true;
    }
  }

  return { memberIds, indeterminate };
}

export type UserGroupMutations = {
  createGroup: (
    groupData: Partial<IGroup>,
    session?: ClientSession,
    observer?: AuthContinuationObserver,
  ) => Promise<IGroup>;
  upsertGroupByExternalId: (
    idOnTheSource: string,
    source: 'entra' | 'local',
    updateData: Partial<IGroup>,
    session?: ClientSession,
    observer?: AuthContinuationObserver,
  ) => Promise<IGroup | null>;
  addUserToGroup: (
    userId: string | Types.ObjectId,
    groupId: string | Types.ObjectId,
    session?: ClientSession,
  ) => Promise<{ user: IUser; group: IGroup | null }>;
  removeUserFromGroup: (
    userId: string | Types.ObjectId,
    groupId: string | Types.ObjectId,
    session?: ClientSession,
  ) => Promise<{ user: IUser; group: IGroup | null }>;
  removeUserFromAllGroups: (userId: string | Types.ObjectId) => Promise<void>;
  updateGroupById: (
    groupId: string | Types.ObjectId,
    data: Record<string, unknown>,
    session?: ClientSession,
    observer?: AuthContinuationObserver,
  ) => Promise<IGroup | null>;
  bulkUpdateGroups: (
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: { session?: ClientSession },
    observer?: AuthContinuationObserver,
  ) => Promise<import('mongoose').UpdateWriteOpResult>;
  syncUserEntraGroups: (
    userId: string | Types.ObjectId,
    entraGroups: Array<{ id: string; name: string; description?: string; email?: string }>,
    session?: ClientSession,
  ) => Promise<{
    user: IUser;
    addedGroups: IGroup[];
    removedGroups: IGroup[];
  }>;
  deleteGroup: (
    groupId: string | Types.ObjectId,
    session?: ClientSession,
  ) => Promise<IGroup | null>;
  removeMemberById: (
    groupId: string | Types.ObjectId,
    memberId: string,
    session?: ClientSession,
  ) => Promise<IGroup | null>;
};

export function createUserGroupMutations(
  mongoose: typeof import('mongoose'),
  cache: Pick<UserGroupCache, 'invalidateMemberGroupsCache' | 'clearMemberGroupsCache'>,
  reads: Pick<UserGroupReads, 'findGroupById' | 'findGroupByExternalId'>,
): UserGroupMutations {
  const { invalidateMemberGroupsCache, clearMemberGroupsCache } = cache;
  const { findGroupById, findGroupByExternalId } = reads;
  /**
   * Create a new group
   * @param groupData - Group data including name, source, and optional idOnTheSource
   * @param session - Optional MongoDB session for transactions
   * @returns The created group
   */
  async function createGroup(
    groupData: Partial<IGroup>,
    session?: ClientSession,
    observer?: AuthContinuationObserver,
  ): Promise<IGroup> {
    const Group = mongoose.models.Group as Model<IGroup>;
    const options = session ? { session } : {};
    const group = await observeAuthPersistence(observer, async () =>
      Group.create([groupData], options).then((groups) => groups[0]),
    );
    await runAfterTransaction(
      session,
      () => invalidateMemberGroupsCache(groupData.memberIds ?? [], observer),
      observer,
    );
    return group;
  }

  /**
   * Update or create a group by external ID
   * @param idOnTheSource - The external ID
   * @param source - The source ('entra' or 'local')
   * @param updateData - Data to update or set if creating
   * @param session - Optional MongoDB session for transactions
   * @returns The updated or created group
   */
  async function upsertGroupByExternalId(
    idOnTheSource: string,
    source: 'entra' | 'local',
    updateData: Partial<IGroup>,
    session?: ClientSession,
    observer?: AuthContinuationObserver,
  ): Promise<IGroup | null> {
    const Group = mongoose.models.Group as Model<IGroup>;
    const options = {
      new: true,
      upsert: true,
      ...(session ? { session } : {}),
    };

    if (updateData.memberIds === undefined) {
      return await Group.findOneAndUpdate({ idOnTheSource, source }, { $set: updateData }, options);
    }
    /** Atomic pre-image (`new: false`) so members added concurrently before the $set are invalidated too. */
    const previous = await Group.findOneAndUpdate(
      { idOnTheSource, source },
      { $set: updateData },
      { ...options, new: false },
    ).lean<IGroup>();
    await runAfterTransaction(
      session,
      () =>
        invalidateMemberGroupsCache(
          [...(previous?.memberIds ?? []), ...(updateData.memberIds ?? [])],
          observer,
        ),
      observer,
    );
    return await findGroupByExternalId(idOnTheSource, source, {}, session);
  }

  /**
   * Add a user to a group
   * Only updates Group.memberIds (one-way relationship)
   * Note: memberIds stores idOnTheSource values, not ObjectIds
   *
   * @param userId - The user ID
   * @param groupId - The group ID to add
   * @param session - Optional MongoDB session for transactions
   * @returns The user and updated group documents
   */
  async function addUserToGroup(
    userId: string | Types.ObjectId,
    groupId: string | Types.ObjectId,
    session?: ClientSession,
  ): Promise<{ user: IUser; group: IGroup | null }> {
    const User = mongoose.models.User as Model<IUser>;
    const Group = mongoose.models.Group as Model<IGroup>;

    const options = { new: true, ...(session ? { session } : {}) };

    const user = await User.findById(userId, 'idOnTheSource', options).lean<{
      idOnTheSource?: string;
      _id: Types.ObjectId;
    }>();
    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }

    const userIdOnTheSource = user.idOnTheSource || userId.toString();
    const updatedGroup = await Group.findByIdAndUpdate(
      groupId,
      { $addToSet: { memberIds: userIdOnTheSource } },
      options,
    ).lean<IGroup>();
    await runAfterTransaction(session, () => invalidateMemberGroupsCache([userIdOnTheSource]));

    return { user: user as IUser, group: updatedGroup };
  }

  /**
   * Remove a user from a group
   * Only updates Group.memberIds (one-way relationship)
   * Note: memberIds stores idOnTheSource values, not ObjectIds
   *
   * @param userId - The user ID
   * @param groupId - The group ID to remove
   * @param session - Optional MongoDB session for transactions
   * @returns The user and updated group documents
   */
  async function removeUserFromGroup(
    userId: string | Types.ObjectId,
    groupId: string | Types.ObjectId,
    session?: ClientSession,
  ): Promise<{ user: IUser; group: IGroup | null }> {
    const User = mongoose.models.User as Model<IUser>;
    const Group = mongoose.models.Group as Model<IGroup>;

    const options = { new: true, ...(session ? { session } : {}) };

    const user = await User.findById(userId, 'idOnTheSource', options).lean<{
      idOnTheSource?: string;
      _id: Types.ObjectId;
    }>();
    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }

    const userIdOnTheSource = user.idOnTheSource || userId.toString();
    const updatedGroup = await Group.findByIdAndUpdate(
      groupId,
      { $pullAll: { memberIds: [userIdOnTheSource] } },
      options,
    ).lean<IGroup>();
    await runAfterTransaction(session, () => invalidateMemberGroupsCache([userIdOnTheSource]));

    return { user: user as IUser, group: updatedGroup };
  }

  /**
   * Sync a user's Entra ID group memberships
   * @param userId - The user ID
   * @param entraGroups - Array of Entra groups with id and name
   * @param session - Optional MongoDB session for transactions
   * @returns The updated user with new group memberships
   */
  async function syncUserEntraGroups(
    userId: string | Types.ObjectId,
    entraGroups: Array<{ id: string; name: string; description?: string; email?: string }>,
    session?: ClientSession,
  ): Promise<{
    user: IUser;
    addedGroups: IGroup[];
    removedGroups: IGroup[];
  }> {
    const User = mongoose.models.User as Model<IUser>;
    const Group = mongoose.models.Group as Model<IGroup>;

    const query = User.findById(userId, { idOnTheSource: 1 });
    if (session) {
      query.session(session);
    }
    const user = await query.lean<{ idOnTheSource?: string; _id: Types.ObjectId }>();

    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }

    /** Get user's idOnTheSource for storing in group.memberIds */
    const userIdOnTheSource = user.idOnTheSource || userId.toString();

    const entraIdMap = new Map<string, boolean>();
    const addedGroups: IGroup[] = [];
    const removedGroups: IGroup[] = [];

    for (const entraGroup of entraGroups) {
      entraIdMap.set(entraGroup.id, true);

      let group = await findGroupByExternalId(entraGroup.id, 'entra', {}, session);

      if (!group) {
        group = await createGroup(
          {
            name: entraGroup.name,
            description: entraGroup.description,
            email: entraGroup.email,
            idOnTheSource: entraGroup.id,
            source: 'entra',
            memberIds: [userIdOnTheSource],
          },
          session,
        );

        addedGroups.push(group);
      } else if (!group.memberIds?.includes(userIdOnTheSource)) {
        const { group: updatedGroup } = await addUserToGroup(userId, group._id, session);
        if (updatedGroup) {
          addedGroups.push(updatedGroup);
        }
      }
    }

    const groupsQuery = Group.find(
      { source: 'entra', memberIds: userIdOnTheSource },
      { _id: 1, idOnTheSource: 1 },
    );
    if (session) {
      groupsQuery.session(session);
    }
    const existingGroups = await groupsQuery.lean<
      Array<{
        _id: Types.ObjectId;
        idOnTheSource?: string;
      }>
    >();

    for (const group of existingGroups) {
      if (group.idOnTheSource && !entraIdMap.has(group.idOnTheSource)) {
        const { group: removedGroup } = await removeUserFromGroup(userId, group._id, session);
        if (removedGroup) {
          removedGroups.push(removedGroup);
        }
      }
    }

    const userQuery = User.findById(userId);
    if (session) {
      userQuery.session(session);
    }
    const updatedUser = await userQuery.lean<IUser>();

    if (!updatedUser) {
      throw new Error(`User not found after update: ${userId}`);
    }

    return {
      user: updatedUser,
      addedGroups,
      removedGroups,
    };
  }

  /**
   * Removes a user from all groups they belong to.
   * @param userId - The user ID (or ObjectId) of the member to remove
   */
  async function removeUserFromAllGroups(userId: string | Types.ObjectId): Promise<void> {
    const Group = mongoose.models.Group as Model<IGroup>;
    await Group.updateMany({ memberIds: userId }, { $pullAll: { memberIds: [userId] } });
    await invalidateMemberGroupsCache([userId]);
  }

  /**
   * Updates a group by its ID.
   * @param groupId - The group's ObjectId
   * @param data - Fields to set via $set
   */
  async function updateGroupById(
    groupId: string | Types.ObjectId,
    data: Record<string, unknown>,
    session?: ClientSession,
    observer?: AuthContinuationObserver,
  ): Promise<IGroup | null> {
    const Group = mongoose.models.Group as Model<IGroup>;
    const options = { new: true, ...(session ? { session } : {}) };
    if (data.memberIds === undefined) {
      return observeAuthPersistence(observer, async () =>
        Group.findByIdAndUpdate(groupId, { $set: data }, options).lean<IGroup>(),
      );
    }
    /** Atomic pre-image (`new: false`) so members added concurrently before the $set are invalidated too. */
    const previous = await observeAuthPersistence(observer, async () =>
      Group.findByIdAndUpdate(
        groupId,
        { $set: data },
        {
          ...options,
          new: false,
        },
      ).lean<IGroup>(),
    );
    const nextMemberIds = Array.isArray(data.memberIds)
      ? data.memberIds.filter(
          (memberId): memberId is string | Types.ObjectId =>
            typeof memberId === 'string' || memberId instanceof Types.ObjectId,
        )
      : [];
    await runAfterTransaction(
      session,
      () =>
        invalidateMemberGroupsCache([...(previous?.memberIds ?? []), ...nextMemberIds], observer),
      observer,
    );
    return previous ? await findGroupById(groupId, {}, session) : null;
  }

  /**
   * Bulk-updates groups matching a filter.
   * @param filter - MongoDB filter query
   * @param update - Update operations
   * @param options - Optional query options (e.g., { session })
   */
  async function bulkUpdateGroups(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: { session?: ClientSession },
    observer?: AuthContinuationObserver,
  ): Promise<import('mongoose').UpdateWriteOpResult> {
    const Group = mongoose.models.Group as Model<IGroup>;
    const result = await Group.updateMany(filter, update, options || {});
    if (result.modifiedCount === 0 && result.upsertedCount === 0) {
      return result;
    }
    const { memberIds, indeterminate } = collectMemberIdsFromGroupUpdate(update);
    if (indeterminate) {
      await runAfterTransaction(options?.session, () => clearMemberGroupsCache(observer), observer);
    } else if (memberIds.length > 0) {
      await runAfterTransaction(
        options?.session,
        () => invalidateMemberGroupsCache(memberIds, observer),
        observer,
      );
    }
    return result;
  }

  /**
   * Delete a group by its ID.
   * @param groupId - The group's ObjectId
   * @param session - Optional MongoDB session for transactions
   */
  async function deleteGroup(
    groupId: string | Types.ObjectId,
    session?: ClientSession,
  ): Promise<IGroup | null> {
    const Group = mongoose.models.Group as Model<IGroup>;
    const options = session ? { session } : {};
    const group = await Group.findByIdAndDelete(groupId, options).lean<IGroup>();
    await runAfterTransaction(session, () => invalidateMemberGroupsCache(group?.memberIds ?? []));
    return group;
  }

  /**
   * Remove a member from a group by raw memberId string ($pull from memberIds).
   * Unlike removeUserFromGroup, this does not look up the user first.
   * @param groupId - The group's ObjectId
   * @param memberId - The raw memberId string to remove (ObjectId or idOnTheSource)
   * @param session - Optional MongoDB session for transactions
   */
  async function removeMemberById(
    groupId: string | Types.ObjectId,
    memberId: string,
    session?: ClientSession,
  ): Promise<IGroup | null> {
    const Group = mongoose.models.Group as Model<IGroup>;
    const options = { new: true, ...(session ? { session } : {}) };
    const group = await Group.findByIdAndUpdate(
      groupId,
      { $pull: { memberIds: memberId } },
      options,
    ).lean<IGroup>();
    await runAfterTransaction(session, () => invalidateMemberGroupsCache([memberId]));
    return group;
  }
  return {
    createGroup,
    upsertGroupByExternalId,
    addUserToGroup,
    removeUserFromGroup,
    removeUserFromAllGroups,
    updateGroupById,
    bulkUpdateGroups,
    syncUserEntraGroups,
    deleteGroup,
    removeMemberById,
  };
}
