/** Canonical object identity only. No SDK, environment or application resource imports. */
import {
  DEFAULT_BASE_PATH as defaultBasePath,
  AVATAR_BASE_PATH,
  INLINE_IMAGE_PATH_PREFIX,
  INLINE_AVATAR_PATH_PREFIX,
} from '../constants';
import { assertPathSegment, assertS3FileName } from '../validation';
const INLINE_STORAGE_PREFIXES = new Map([
  [defaultBasePath, INLINE_IMAGE_PATH_PREFIX],
  [AVATAR_BASE_PATH, INLINE_AVATAR_PATH_PREFIX],
]);
interface S3KeyBase {
  basePath: string;
  userId: string;
  fileName: string;
  includeRegionInPath?: boolean;
  useInlinePath?: boolean;
}

export interface S3KeyParts extends S3KeyBase {
  storageRegion?: string;
  tenantId?: string;
  inlinePathPrefix?: string;
}

export interface S3KeyOptions extends S3KeyBase {
  tenantId?: string | null;
  storageRegion?: string | null;
}

const parseS3PathSegment = (value: string | undefined): string | null => {
  try {
    return assertPathSegment('S3 key segment', value, 'getS3Key');
  } catch {
    return null;
  }
};

const parseS3FileName = (value: string | undefined): string | null => {
  try {
    return assertS3FileName('fileName', value, 'parseS3Key');
  } catch {
    return null;
  }
};

const getParsedPathFlags = (
  storageRegion?: string,
  inlinePathPrefix?: string,
): Pick<S3KeyParts, 'useInlinePath' | 'inlinePathPrefix'> => {
  if (inlinePathPrefix) {
    return { useInlinePath: true, inlinePathPrefix };
  }
  return { useInlinePath: false };
};

const getInlinePathPrefix = ({
  basePath,
  useInlinePath,
}: Pick<S3KeyOptions, 'basePath' | 'useInlinePath'>): string | null => {
  const prefix = INLINE_STORAGE_PREFIXES.get(basePath);
  const shouldUseInlinePath = useInlinePath ?? false;
  if (!shouldUseInlinePath) {
    return null;
  }
  if (!prefix) {
    throw new Error(`[getS3Key] inline path is not supported for basePath: "${basePath}"`);
  }
  return prefix;
};

export function buildS3Key(options: S3KeyOptions): string {
  const { includeRegionInPath = false } = options;
  const safeBasePath = assertPathSegment('basePath', options.basePath, 'getS3Key');
  const safeUserId = assertPathSegment('userId', options.userId, 'getS3Key');
  const safeFileName = assertS3FileName('fileName', options.fileName, 'getS3Key');
  const inlinePathPrefix = getInlinePathPrefix({
    ...options,
    basePath: safeBasePath,
  });

  const pathParts: string[] = [];
  if (inlinePathPrefix) {
    pathParts.push(inlinePathPrefix);
  }
  if (includeRegionInPath) {
    const storageRegion = options.storageRegion;
    pathParts.push('r', assertPathSegment('storageRegion', storageRegion, 'getS3Key'));
  }
  if (options.tenantId) {
    pathParts.push('t', assertPathSegment('tenantId', options.tenantId, 'getS3Key'));
  }
  pathParts.push(safeBasePath, safeUserId, safeFileName);
  return pathParts.join('/');
}

const parseS3KeyParts = (
  keyParts: string[],
  storageRegion?: string,
  inlinePathPrefix?: string,
): S3KeyParts | null => {
  if (keyParts[0] === 't') {
    if (keyParts.length < 5) {
      return null;
    }
    const [, tenantId, basePath, userId, ...fileNameParts] = keyParts;
    const safeTenantId = parseS3PathSegment(tenantId);
    const safeBasePath = parseS3PathSegment(basePath);
    const safeUserId = parseS3PathSegment(userId);
    const safeFileName = parseS3FileName(fileNameParts.join('/'));
    if (!safeTenantId || !safeBasePath || !safeUserId || !safeFileName) {
      return null;
    }
    const expectedInlinePrefix = INLINE_STORAGE_PREFIXES.get(safeBasePath);
    if (inlinePathPrefix && expectedInlinePrefix !== inlinePathPrefix) {
      return null;
    }
    return {
      ...(storageRegion ? { storageRegion } : {}),
      ...(storageRegion ? { includeRegionInPath: true } : {}),
      ...getParsedPathFlags(storageRegion, inlinePathPrefix),
      tenantId: safeTenantId,
      basePath: safeBasePath,
      userId: safeUserId,
      fileName: safeFileName,
    };
  }

  if (keyParts.length < 3) {
    return null;
  }
  const [basePath, userId, ...fileNameParts] = keyParts;
  const safeBasePath = parseS3PathSegment(basePath);
  const safeUserId = parseS3PathSegment(userId);
  const safeFileName = parseS3FileName(fileNameParts.join('/'));
  if (!safeBasePath || !safeUserId || !safeFileName) {
    return null;
  }
  const expectedInlinePrefix = INLINE_STORAGE_PREFIXES.get(safeBasePath);
  if (inlinePathPrefix && expectedInlinePrefix !== inlinePathPrefix) {
    return null;
  }
  return {
    ...(storageRegion ? { storageRegion } : {}),
    ...(storageRegion ? { includeRegionInPath: true } : {}),
    ...getParsedPathFlags(storageRegion, inlinePathPrefix),
    basePath: safeBasePath,
    userId: safeUserId,
    fileName: safeFileName,
  };
};

export const parseS3Key = (key: string): S3KeyParts | null => {
  const normalizedKey = key.replace(/^\/+/, '');
  const keyParts = normalizedKey.split('/');
  const inlinePathPrefix =
    keyParts[0] === INLINE_IMAGE_PATH_PREFIX || keyParts[0] === INLINE_AVATAR_PATH_PREFIX
      ? keyParts.shift()
      : undefined;

  if (keyParts[0] === 'r') {
    if (keyParts.length < 5) {
      return null;
    }
    const [, storageRegion, ...remainingParts] = keyParts;
    const safeStorageRegion = parseS3PathSegment(storageRegion);
    if (!safeStorageRegion) {
      return null;
    }
    return parseS3KeyParts(remainingParts, safeStorageRegion, inlinePathPrefix);
  }

  return parseS3KeyParts(keyParts, undefined, inlinePathPrefix);
};
