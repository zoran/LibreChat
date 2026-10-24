/** Public group-method composition; private owners share cache, read and mutation identities. */
import type { TPrincipalSearchResult, PrincipalType } from 'librechat-data-provider';
import type { Types, ClientSession } from 'mongoose';
import type { AuthContinuationObserver } from './authPersistence';
import type { UserGroupDeps } from './userGroup/cache';
import type { IGroup, IUser } from '~/types';
import { createUserGroupMutations } from './userGroup/mutations';
import { createUserGroupCache } from './userGroup/cache';
import { createUserGroupReads } from './userGroup/reads';
export { runAfterTransaction } from './userGroup/cache';
export type { UserGroupDeps } from './userGroup/cache';

export function createUserGroupMethods(
  mongoose: typeof import('mongoose'),
  deps: UserGroupDeps = {},
): {
  findGroupById: (
    groupId: string | Types.ObjectId,
    projection?: Record<string, 0 | 1>,
    session?: ClientSession,
  ) => Promise<IGroup | null>;
  findGroupByExternalId: (
    idOnTheSource: string,
    source?: 'entra' | 'local',
    projection?: Record<string, 0 | 1>,
    session?: ClientSession,
  ) => Promise<IGroup | null>;
  findGroupsByExternalIds: (
    idsOnTheSource: string[],
    source?: 'entra' | 'local',
    session?: ClientSession,
  ) => Promise<IGroup[]>;
  findGroupsByNamePattern: (
    namePattern: string,
    source?: 'entra' | 'local' | null,
    limit?: number,
    session?: ClientSession,
  ) => Promise<IGroup[]>;
  findGroupsByMemberId: (
    userId: string | Types.ObjectId,
    session?: ClientSession,
  ) => Promise<IGroup[]>;
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
  findGroupByQuery: (
    filter: Record<string, unknown>,
    session?: ClientSession,
  ) => Promise<IGroup | null>;
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
  getUserGroups: (userId: string | Types.ObjectId, session?: ClientSession) => Promise<IGroup[]>;
  getUserPrincipals: (
    params: {
      userId: string | Types.ObjectId;
      role?: string | null;
      idOnTheSource?: string | null;
    },
    session?: ClientSession,
  ) => Promise<Array<{ principalType: PrincipalType; principalId?: string | Types.ObjectId }>>;
  syncUserEntraGroups: (
    userId: string | Types.ObjectId,
    entraGroups: Array<{ id: string; name: string; description?: string; email?: string }>,
    session?: ClientSession,
  ) => Promise<{
    user: IUser;
    addedGroups: IGroup[];
    removedGroups: IGroup[];
  }>;
  searchPrincipals: (
    searchPattern: string,
    limitPerType?: number,
    typeFilter?: Array<PrincipalType.USER | PrincipalType.GROUP | PrincipalType.ROLE> | null,
    session?: ClientSession,
  ) => Promise<TPrincipalSearchResult[]>;
  calculateRelevanceScore: (item: TPrincipalSearchResult, searchPattern: string) => number;
  sortPrincipalsByRelevance: <
    T extends { _searchScore?: number; type: string; name?: string; email?: string },
  >(
    results: T[],
  ) => T[];
  listGroups: (
    filter?: {
      source?: 'local' | 'entra';
      search?: string;
      limit?: number;
      offset?: number;
    },
    session?: ClientSession,
  ) => Promise<IGroup[]>;
  countGroups: (
    filter?: { source?: 'local' | 'entra'; search?: string },
    session?: ClientSession,
  ) => Promise<number>;
  deleteGroup: (
    groupId: string | Types.ObjectId,
    session?: ClientSession,
  ) => Promise<IGroup | null>;
  removeMemberById: (
    groupId: string | Types.ObjectId,
    memberId: string,
    session?: ClientSession,
  ) => Promise<IGroup | null>;
} {
  const cache = createUserGroupCache(mongoose, deps);
  const reads = createUserGroupReads(mongoose, cache);
  const mutations = createUserGroupMutations(mongoose, cache, reads);
  return {
    findGroupById: reads.findGroupById,
    findGroupByExternalId: reads.findGroupByExternalId,
    findGroupsByExternalIds: reads.findGroupsByExternalIds,
    findGroupsByNamePattern: reads.findGroupsByNamePattern,
    findGroupsByMemberId: reads.findGroupsByMemberId,
    createGroup: mutations.createGroup,
    upsertGroupByExternalId: mutations.upsertGroupByExternalId,
    addUserToGroup: mutations.addUserToGroup,
    removeUserFromGroup: mutations.removeUserFromGroup,
    removeUserFromAllGroups: mutations.removeUserFromAllGroups,
    findGroupByQuery: reads.findGroupByQuery,
    updateGroupById: mutations.updateGroupById,
    bulkUpdateGroups: mutations.bulkUpdateGroups,
    getUserGroups: reads.getUserGroups,
    getUserPrincipals: reads.getUserPrincipals,
    syncUserEntraGroups: mutations.syncUserEntraGroups,
    searchPrincipals: reads.searchPrincipals,
    calculateRelevanceScore: reads.calculateRelevanceScore,
    sortPrincipalsByRelevance: reads.sortPrincipalsByRelevance,
    listGroups: reads.listGroups,
    countGroups: reads.countGroups,
    deleteGroup: mutations.deleteGroup,
    removeMemberById: mutations.removeMemberById,
  };
}

export type UserGroupMethods = ReturnType<typeof createUserGroupMethods>;
