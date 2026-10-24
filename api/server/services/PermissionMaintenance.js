/** Permission operation custody and principal preparation; persistence and identity remain external. */
function createPermissionMaintenance() {
  const live = new Set();
  const waiters = new Set();
  let pausedBy = null;
  let stopped = false;
  let uncertain = false;
  let writes = 0;

  function run(start) {
    if (stopped || pausedBy !== null) {
      throw Object.assign(new Error('APP_QUIESCING'), { statusCode: 503 });
    }
    let pending = 0;
    let rootComplete = false;
    const finish = () => {
      if (!rootComplete || pending !== 0) return;
      live.delete(operation);
      if (live.size === 0) {
        for (const resolve of waiters) resolve();
        waiters.clear();
      }
    };
    const operation = Object.freeze({
      markUncertain() {
        uncertain = true;
      },
      track(action) {
        if (!live.has(operation)) {
          uncertain = true;
          throw new Error('Permission continuation used after settlement');
        }
        pending++;
        let original;
        try {
          original = action();
        } catch (error) {
          pending--;
          finish();
          throw error;
        }
        return Promise.resolve(original).finally(() => {
          pending--;
          finish();
        });
      },
      write(action) {
        return operation.track(() => {
          writes++;
          let original;
          try {
            original = action();
          } catch (error) {
            writes--;
            uncertain = true;
            throw error;
          }
          return Promise.resolve(original)
            .catch((error) => {
              uncertain = true;
              throw error;
            })
            .finally(() => {
              writes--;
            });
        });
      },
    });
    live.add(operation);
    let original;
    try {
      original = operation.track(() => start(operation));
    } catch (error) {
      rootComplete = true;
      finish();
      throw error;
    }
    return original.finally(() => {
      rootComplete = true;
      finish();
    });
  }

  return {
    run,
    own(handler) {
      // These two controller entries have no next callback; their original promises own completion.
      return function permissionHandler(req, res) {
        try {
          return run((operation) => Reflect.apply(handler, this, [req, res, operation]));
        } catch (error) {
          if (error.message !== 'APP_QUIESCING') throw error;
          res.setHeader('Retry-After', '1');
          return res.status(503).json({ error: 'APP_QUIESCING' });
        }
      };
    },
    pauseAdmissions(requestId) {
      if (
        stopped ||
        typeof requestId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(requestId) ||
        (pausedBy !== null && pausedBy !== requestId)
      )
        return false;
      pausedBy = requestId;
      return true;
    },
    resumeAdmissions(requestId) {
      if (stopped || uncertain || pausedBy !== requestId) return false;
      pausedBy = null;
      return true;
    },
    async getMaintenanceCensus(requestId) {
      return {
        admissionClosed: stopped || pausedBy !== null,
        queuedContinuations: live.size,
        pendingWrites: writes,
        complete: !uncertain && pausedBy === requestId,
      };
    },
    stopAdmissions() {
      stopped = true;
    },
    async drain() {
      stopped = true;
      if (live.size !== 0) await new Promise((resolve) => waiters.add(resolve));
      if (uncertain) throw new Error('PERMISSION_SETTLEMENT_UNCONFIRMED');
    },
  };
}

/** The four existing principal-preparation methods share the actual permission operation. */
function createPermissionPrincipalMethods({
  db,
  logger,
  PrincipalType,
  isEnabled,
  ensureDirectoryPrincipalUser,
  getGroupMembers,
  getGroupOwners,
}) {
  const write = (observer, action) => (observer ? observer.write(action) : action());
  const ensureLocalUserPrincipalExists = async (principalId) => {
    const user = await db.findUser({ _id: principalId }, '_id');
    if (!user) {
      throw new Error('User principal not found');
    }
    return user._id.toString();
  };

  const ensureLocalGroupPrincipalExists = async (principalId) => {
    const group = await db.findGroupById(principalId, { _id: 1 });
    if (!group) {
      throw new Error('Group principal not found');
    }
    return group._id.toString();
  };

  /**
   * Ensures a principal exists in the database based on TPrincipal data
   * Creates user if it doesn't exist locally (for Entra ID users)
   * @param {Object} principal - TPrincipal object from frontend
   * @param {string} principal.type - PrincipalType.USER, PrincipalType.GROUP, or PrincipalType.PUBLIC
   * @param {string} [principal.id] - Local database ID (null for Entra ID principals not yet synced)
   * @param {string} principal.name - Display name
   * @param {string} [principal.email] - Email address
   * @param {string} [principal.source] - 'local' or 'entra'
   * @param {string} [principal.idOnTheSource] - Entra ID object ID for external principals
   * @returns {Promise<string|null>} Returns the principalId for database operations, null for public
   */
  const ensurePrincipalExists = async function (principal, observer = undefined) {
    if (principal.type === PrincipalType.PUBLIC) {
      return null;
    }

    if (principal.type === PrincipalType.USER && principal.id) {
      return await ensureLocalUserPrincipalExists(principal.id);
    }

    if (principal.type === PrincipalType.USER && principal.source === 'entra') {
      return ensureDirectoryPrincipalUser(principal, {
        findUserBySourceId: async (idOnTheSource) => {
          const user = await db.findUser({ idOnTheSource });
          return user ? { id: user._id.toString() } : null;
        },
        findUserByEmail: async (email) => {
          const user = await db.findUser({ email });
          return user ? { id: user._id.toString() } : null;
        },
        createUser: async (userData) => {
          const userId = await write(observer, () => db.createUser(userData, true, true));
          return userId.toString();
        },
      });
    }

    if (principal.type === PrincipalType.GROUP) {
      throw new Error('Group principals should be handled by group-specific methods');
    }

    throw new Error(`Unsupported principal type: ${principal.type}`);
  };

  /**
   * Ensures a group principal exists in the database based on TPrincipal data
   * Creates group if it doesn't exist locally (for Entra ID groups)
   * For Entra ID groups, always synchronizes member IDs when authentication context is provided
   * @param {Object} principal - TPrincipal object from frontend
   * @param {string} principal.type - Must be PrincipalType.GROUP
   * @param {string} [principal.id] - Local database ID (null for Entra ID principals not yet synced)
   * @param {string} principal.name - Display name
   * @param {string} [principal.email] - Email address
   * @param {string} [principal.description] - Group description
   * @param {string} [principal.source] - 'local' or 'entra'
   * @param {string} [principal.idOnTheSource] - Entra ID object ID for external principals
   * @param {Object} [authContext] - Optional authentication context for fetching member data
   * @param {string} [authContext.accessToken] - Access token for Graph API calls
   * @param {string} [authContext.sub] - Subject identifier
   * @returns {Promise<string>} Returns the groupId for database operations
   */
  const ensureGroupPrincipalExists = async function (
    principal,
    authContext = null,
    observer = undefined,
  ) {
    if (principal.type !== PrincipalType.GROUP) {
      throw new Error(
        `Invalid principal type: ${principal.type}. Expected '${PrincipalType.GROUP}'`,
      );
    }

    if (principal.id && principal.source !== 'entra') {
      return await ensureLocalGroupPrincipalExists(principal.id);
    }

    if (principal.source === 'entra') {
      if (!principal.name || !principal.idOnTheSource) {
        throw new Error('Entra ID group principals must have name and idOnTheSource');
      }

      let memberIds = [];
      if (authContext && authContext.accessToken && authContext.sub) {
        try {
          memberIds = await getGroupMembers(
            authContext.accessToken,
            authContext.sub,
            principal.idOnTheSource,
          );

          // Include group owners as members if feature is enabled
          if (isEnabled(process.env.ENTRA_ID_INCLUDE_OWNERS_AS_MEMBERS)) {
            const ownerIds = await getGroupOwners(
              authContext.accessToken,
              authContext.sub,
              principal.idOnTheSource,
            );
            if (ownerIds && ownerIds.length > 0) {
              memberIds.push(...ownerIds);
              // Remove duplicates
              memberIds = [...new Set(memberIds)];
            }
          }
        } catch (error) {
          logger.error('Failed to fetch group members from Graph API:', error);
        }
      }

      let existingGroup = await db.findGroupByExternalId(principal.idOnTheSource, 'entra');

      if (!existingGroup && principal.email) {
        existingGroup = await db.findGroupByQuery({ email: principal.email.toLowerCase() });
      }

      if (existingGroup) {
        const updateData = {};
        let needsUpdate = false;

        if (!existingGroup.idOnTheSource && principal.idOnTheSource) {
          updateData.idOnTheSource = principal.idOnTheSource;
          updateData.source = 'entra';
          needsUpdate = true;
        }

        if (principal.description && existingGroup.description !== principal.description) {
          updateData.description = principal.description;
          needsUpdate = true;
        }

        if (principal.email && existingGroup.email !== principal.email.toLowerCase()) {
          updateData.email = principal.email.toLowerCase();
          needsUpdate = true;
        }

        if (authContext && authContext.accessToken && authContext.sub) {
          updateData.memberIds = memberIds;
          needsUpdate = true;
        }

        if (needsUpdate) {
          await write(observer, () =>
            observer
              ? db.updateGroupById(existingGroup._id, updateData, undefined, observer)
              : db.updateGroupById(existingGroup._id, updateData),
          );
        }

        return existingGroup._id.toString();
      }

      const groupData = {
        name: principal.name,
        source: 'entra',
        idOnTheSource: principal.idOnTheSource,
        memberIds: memberIds, // Store idOnTheSource values of group members (empty if no auth context)
      };

      if (principal.email) {
        groupData.email = principal.email.toLowerCase();
      }

      if (principal.description) {
        groupData.description = principal.description;
      }

      const newGroup = await write(observer, () =>
        observer ? db.createGroup(groupData, undefined, observer) : db.createGroup(groupData),
      );
      return newGroup._id.toString();
    }
    if (principal.id && authContext == null) {
      return principal.id;
    }

    throw new Error(`Unsupported group principal source: ${principal.source}`);
  };

  return { ensurePrincipalExists, ensureGroupPrincipalExists };
}

const permissionMaintenance = createPermissionMaintenance();
module.exports = {
  createPermissionMaintenance,
  createPermissionPrincipalMethods,
  permissionMaintenance,
};
