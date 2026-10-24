import { logger } from '@librechat/data-schemas';
import type { mongo } from 'mongoose';

/** Startup owns this observer; collection helpers retain only their captured driver originals. */
export interface MigrationCheckObserver {
  assertCurrent(db: mongo.Db): void;
  track<T>(start: () => T | Promise<T>): Promise<T>;
  write<T>(start: () => T | Promise<T>): Promise<T>;
  cleanup<T>(start: () => T | Promise<T>): Promise<T>;
  markUncertain(error: unknown): void;
}

/**
 * Ensures that a collection exists in the database.
 * Unobserved operator callers retain their existing best-effort compatibility probe.
 * Observed startup never normalizes an uncertain original into successful preparation.
 * @param db - The MongoDB database instance
 * @param collectionName - The name of the collection to ensure exists
 */
export async function ensureCollectionExists(
  db: mongo.Db,
  collectionName: string,
  observer?: MigrationCheckObserver,
): Promise<void> {
  let cursor: ReturnType<mongo.Db['listCollections']> | undefined;
  let failed = false;
  let failure: unknown;
  const retainFailure = (error: unknown) => {
    if (!failed) failure = error;
    failed = true;
    observer?.markUncertain(error);
  };
  try {
    observer?.assertCurrent(db);
    const read = () => {
      cursor = db.listCollections({ name: collectionName });
      return cursor.toArray();
    };
    const collections = await (observer ? observer.track(read) : read());
    if (collections.length === 0) {
      const create = () => db.createCollection(collectionName);
      await (observer ? observer.write(create) : create());
      logger.info(`Created collection: ${collectionName}`);
    } else {
      logger.debug(`Collection already exists: ${collectionName}`);
    }
  } catch (error) {
    retainFailure(error);
  } finally {
    const acquired = cursor;
    if (acquired) {
      try {
        const close = () => acquired.close();
        await (observer ? observer.cleanup(close) : close());
      } catch (error) {
        retainFailure(error);
      }
    }
  }
  if (failed) {
    logger.error(`Failed to check/create "${collectionName}" collection:`, failure);
    if (observer) throw failure;
    try {
      // Preserve the operator compatibility read; findOne does not create a collection.
      await db.collection(collectionName).findOne({}, { projection: { _id: 1 } });
    } catch (createError) {
      logger.error(`Could not ensure collection ${collectionName} exists:`, createError);
    }
  }
}

/**
 * Ensures that all required collections exist for the permission system.
 * This includes aclentries, groups, accessroles, and any other collections
 * needed for migrations and permission checks.
 * @param db - The MongoDB database instance
 */
export async function ensureRequiredCollectionsExist(
  db: mongo.Db,
  observer?: MigrationCheckObserver,
): Promise<void> {
  const requiredCollections = [
    'aclentries', // ACL permission entries
    'groups', // User groups
    'accessroles', // Access roles for permissions
    'agents', // Agents collection
    'promptgroups', // Prompt groups collection
    'projects', // Projects collection
    'chatprojects', // Private chat organization projects
  ];

  logger.debug('Ensuring required collections exist for permission system');

  for (const collectionName of requiredCollections) {
    await ensureCollectionExists(db, collectionName, observer);
  }

  logger.debug('All required collections have been checked/created');
}
