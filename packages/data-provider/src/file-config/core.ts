/** core.ts owns file defaults/schema plus the single MIME compiler/cache/merge lifecycle. */
import { z } from 'zod';
import type { EndpointFileConfig, FileConfig, RegexLike } from '../types/files';
import {
  DEFAULT_SKILL_IMPORT_CLEANUP_CONCURRENCY,
  defaultOCRMimeTypes,
  defaultTextMimeTypes,
  defaultSTTMimeTypes,
  supportedMimeTypes,
} from './catalog';
import { EModelEndpoint, isAgentsEndpoint, isDocumentSupportedProvider } from '../schemas';
import { managedUploadsConfigSchema } from './managed';
import { normalizeEndpointName } from '../utils';

export const megabyte = 1024 * 1024;
/** Helper function to get megabytes value */
export const mbToBytes = (mb: number): number => mb * megabyte;

const defaultSizeLimit = mbToBytes(512);
const defaultSkillImportSizeLimit = mbToBytes(50);
const defaultTokenLimit = 100000;
const defaultContextSizeLimit = mbToBytes(128);
const defaultContextCharLimit = 1_000_000;
const assistantsFileConfig = {
  fileLimit: 10,
  fileSizeLimit: defaultSizeLimit,
  totalSizeLimit: defaultSizeLimit,
  supportedMimeTypes,
  disabled: false,
};

export const fileConfig = {
  endpoints: {
    [EModelEndpoint.assistants]: assistantsFileConfig,
    [EModelEndpoint.azureAssistants]: assistantsFileConfig,
    [EModelEndpoint.agents]: assistantsFileConfig,
    [EModelEndpoint.anthropic]: {
      fileLimit: 10,
      fileSizeLimit: defaultSizeLimit,
      totalSizeLimit: defaultSizeLimit,
      supportedMimeTypes,
      disabled: false,
    },
    default: {
      fileLimit: 10,
      fileSizeLimit: defaultSizeLimit,
      totalSizeLimit: defaultSizeLimit,
      supportedMimeTypes,
      disabled: false,
    },
  },
  skills: {
    fileSizeLimit: defaultSkillImportSizeLimit,
    importCleanupConcurrency: DEFAULT_SKILL_IMPORT_CLEANUP_CONCURRENCY,
  },
  serverFileSizeLimit: defaultSizeLimit,
  avatarSizeLimit: mbToBytes(2),
  fileTokenLimit: defaultTokenLimit,
  fileContextSizeLimit: defaultContextSizeLimit,
  fileContextCharLimit: defaultContextCharLimit,
  clientImageResize: {
    enabled: false,
    maxWidth: 1900,
    maxHeight: 1900,
    quality: 0.92,
    enforced: false,
  },
  ocr: {
    supportedMimeTypes: defaultOCRMimeTypes,
  },
  text: {
    supportedMimeTypes: defaultTextMimeTypes,
  },
  stt: {
    supportedMimeTypes: defaultSTTMimeTypes,
  },
  checkType: function (fileType: string, supportedTypes: RegexLike[] = supportedMimeTypes) {
    return supportedTypes.some((regex) => regex.test(fileType));
  },
};

const supportedMimeTypesSchema = z
  .array(
    z.string().superRefine((pattern, context) => {
      try {
        compileMimeRegex(pattern);
      } catch {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Invalid MIME type regex: not supported by the configured regex engine',
        });
      }
    }),
  )
  .optional();

export const DefaultLLMDeliveryPath = z.enum(['provider', 'text', 'none']);
export type TDefaultLLMDeliveryPath = z.infer<typeof DefaultLLMDeliveryPath>;

export const defaultLLMDeliveryPathSchema = z.object({
  fallback: DefaultLLMDeliveryPath.optional(),
  overrides: z.record(DefaultLLMDeliveryPath).optional(),
});
export type TDefaultLLMDeliveryPathConfig = z.infer<typeof defaultLLMDeliveryPathSchema>;
type TDeliveryPathOverrides = NonNullable<TDefaultLLMDeliveryPathConfig['overrides']>;

export const endpointFileConfigSchema = z.object({
  disabled: z.boolean().optional(),
  fileLimit: z.number().min(0).optional(),
  fileSizeLimit: z.number().min(0).optional(),
  totalSizeLimit: z.number().min(0).optional(),
  supportedMimeTypes: supportedMimeTypesSchema.optional(),
  defaultLLMDeliveryPath: defaultLLMDeliveryPathSchema.optional(),
  legacyFileUploadUX: z.boolean().optional(),
  textFallbackWithoutTools: z.boolean().optional(),
});

const skillFileConfigSchema = z.object({
  fileSizeLimit: z.number().min(0).optional(),
  importCleanupConcurrency: z.number().int().positive().optional(),
});

export const fileConfigSchema = z.object({
  managedUploads: managedUploadsConfigSchema.optional(),
  retentionHours: z.number().finite().positive().optional(),
  endpoints: z.record(endpointFileConfigSchema).optional(),
  skills: skillFileConfigSchema.optional(),
  serverFileSizeLimit: z.number().min(0).optional(),
  avatarSizeLimit: z.number().min(0).optional(),
  fileTokenLimit: z.number().min(0).optional(),
  fileContextSizeLimit: z.number().min(0).optional(),
  fileContextCharLimit: z.number().min(0).optional(),
  codeEnvLivenessSafeWindowMs: z.number().min(0).optional(),
  imageGeneration: z
    .object({
      percentage: z.number().min(0).max(100).optional(),
      px: z.number().min(0).optional(),
    })
    .optional(),
  clientImageResize: z
    .object({
      enabled: z.boolean().optional(),
      maxWidth: z.number().min(1).optional(),
      maxHeight: z.number().min(1).optional(),
      quality: z.number().min(0).max(1).optional(),
    })
    .optional(),
  ocr: z
    .object({
      supportedMimeTypes: supportedMimeTypesSchema.optional(),
    })
    .optional(),
  text: z
    .object({
      supportedMimeTypes: supportedMimeTypesSchema.optional(),
    })
    .optional(),
  defaultLLMDeliveryPath: defaultLLMDeliveryPathSchema.optional(),
  legacyFileUploadUX: z.boolean().optional(),
  textFallbackWithoutTools: z.boolean().optional(),
});

export type TFileConfig = z.infer<typeof fileConfigSchema>;

/**
 * Compiler for admin-supplied MIME patterns. Defaults to native `RegExp`, which browser
 * builds keep so no extra dependency is bundled. The server swaps in a linear-time engine
 * via `setFileConfigRegexCompiler` so an admin-authored catastrophic-backtracking pattern
 * cannot ReDoS the shared event loop when tested against an uploaded file's MIME type.
 */
let compileMimeRegex: (pattern: string) => RegexLike = (pattern) => new RegExp(pattern);

type DynamicFileConfig = z.infer<typeof fileConfigSchema>;

/** Merged results are memoized per `dynamic` object identity; callers must treat them as read-only. */
let mergedConfigCache = new WeakMap<DynamicFileConfig, FileConfig>();
let staticMergedConfig: FileConfig | undefined;

/** Override the MIME-pattern compiler; the server injects a linear-time engine at startup. */
export const setFileConfigRegexCompiler = (compile: (pattern: string) => RegexLike): void => {
  compileMimeRegex = compile;
  mergedConfigCache = new WeakMap();
  staticMergedConfig = undefined;
};

/** Returned when every configured pattern fails to compile, so consumers that read an empty
 *  allowlist as "no restriction" fail closed instead of allowing every file. */
const rejectAllMimeMatcher: RegexLike = { test: () => false };

/** Helper function to safely convert string patterns to matcher objects */
export const convertStringsToRegex = (patterns: string[]): RegexLike[] => {
  const compiled = patterns.reduce((acc: RegexLike[], pattern) => {
    try {
      acc.push(compileMimeRegex(pattern));
    } catch (error) {
      console.error(`Invalid regex pattern "${pattern}" skipped.`, error);
    }
    return acc;
  }, [] as RegexLike[]);
  // Every configured pattern was dropped. Return an explicit reject-all matcher so consumers that
  // read an empty allowlist as "no restriction" fail closed instead of allowing every file.
  if (patterns.length > 0 && compiled.length === 0) {
    console.error(
      `All ${patterns.length} MIME type pattern(s) were invalid and skipped; the resulting allowlist rejects every file.`,
    );
    return [rejectAllMimeMatcher];
  }
  return compiled;
};

/** Detects whether the given MIME type patterns accept all file types (e.g., `.*` or `.+`). */
export const isPermissiveMimeConfig = (types?: RegexLike[]): boolean => {
  if (!types || types.length === 0) {
    return false;
  }
  return types.some((regex) => regex.test('x-librechat/x-probe'));
};

/**
 * Detects whether an endpoint's `supportedMimeTypes` were set by the admin rather than inherited
 * from the built-in default list. Inheritance is signaled by referential identity with
 * `supportedMimeTypes`, which `mergeWithDefault` preserves for unconfigured endpoints.
 */
export const isExplicitMimeConfig = (types?: RegexLike[]): types is RegexLike[] => {
  if (!types || types.length === 0) {
    return false;
  }
  return types !== supportedMimeTypes;
};

/**
 * Gets the appropriate endpoint file configuration with standardized lookup logic.
 *
 * @param params - Object containing fileConfig, endpoint, and optional conversationEndpoint
 * @param params.fileConfig - The merged file configuration
 * @param params.endpoint - The endpoint name to look up
 * @param params.conversationEndpoint - Optional conversation endpoint for additional context
 * @returns The endpoint file configuration or undefined
 */
/**
 * Merges an endpoint config with the default config to ensure all fields are populated.
 * For document-supported providers, uses the comprehensive MIME type list (includes videos/audio).
 */
function mergeWithDefault(
  endpointConfig: EndpointFileConfig,
  defaultConfig: EndpointFileConfig,
  endpoint?: string | null,
): EndpointFileConfig {
  /** Use comprehensive MIME types for document-supported providers */
  const defaultMimeTypes = isDocumentSupportedProvider(endpoint)
    ? supportedMimeTypes
    : defaultConfig.supportedMimeTypes;

  return {
    disabled: endpointConfig.disabled ?? defaultConfig.disabled,
    fileLimit: endpointConfig.fileLimit ?? defaultConfig.fileLimit,
    fileSizeLimit: endpointConfig.fileSizeLimit ?? defaultConfig.fileSizeLimit,
    totalSizeLimit: endpointConfig.totalSizeLimit ?? defaultConfig.totalSizeLimit,
    supportedMimeTypes: endpointConfig.supportedMimeTypes ?? defaultMimeTypes,
    defaultLLMDeliveryPath: mergeDeliveryPathConfig(
      endpointConfig.defaultLLMDeliveryPath,
      defaultConfig.defaultLLMDeliveryPath,
    ),
    legacyFileUploadUX: endpointConfig.legacyFileUploadUX ?? defaultConfig.legacyFileUploadUX,
    textFallbackWithoutTools:
      endpointConfig.textFallbackWithoutTools ?? defaultConfig.textFallbackWithoutTools,
  };
}

/**
 * Deep-merges delivery-path config so an endpoint that supplies only one override
 * still inherits the default's fallback and shared overrides. Whole-object
 * replacement would silently drop the inherited routing.
 */
function mergeDeliveryPathConfig(
  endpointValue?: TDefaultLLMDeliveryPathConfig,
  defaultValue?: TDefaultLLMDeliveryPathConfig,
): TDefaultLLMDeliveryPathConfig | undefined {
  if (!endpointValue) {
    return defaultValue;
  }
  if (!defaultValue) {
    return endpointValue;
  }
  /* An endpoint fallback terminates resolution after that endpoint's own overrides,
   * so inheriting the lower layer's overrides would promote them above it. Only when
   * the endpoint declares no fallback does resolution continue downward, and then the
   * merged map reproduces the chain exactly: endpoint overrides, default overrides,
   * default fallback. */
  if (endpointValue.fallback != null) {
    return endpointValue;
  }
  const hasOverrides = endpointValue.overrides != null || defaultValue.overrides != null;
  return {
    ...(defaultValue.fallback != null ? { fallback: defaultValue.fallback } : {}),
    ...(hasOverrides
      ? { overrides: { ...shadowByWildcard(defaultValue.overrides, endpointValue.overrides) } }
      : {}),
  };
}

/**
 * Flattens two override layers into one map that still resolves like the layered chain.
 * Resolution reads exact keys before wildcards, so a plain spread would let a lower
 * layer's `image/png` outrank the upper layer's `image/*`. Dropping the entries an
 * upper wildcard covers restores precedence without changing how lookups work.
 */
function shadowByWildcard(
  lower?: TDeliveryPathOverrides,
  upper?: TDeliveryPathOverrides,
): TDeliveryPathOverrides {
  if (!lower) {
    return { ...upper };
  }
  const upperWildcards = new Set<string>();
  for (const key in upper) {
    if (key.endsWith('/*')) {
      upperWildcards.add(key.slice(0, -1));
    }
  }
  if (upperWildcards.size === 0) {
    return { ...lower, ...upper };
  }
  const retained: TDeliveryPathOverrides = {};
  for (const key in lower) {
    const isShadowed =
      !key.endsWith('/*') &&
      upperWildcards.has(key.slice(0, key.indexOf('/') + 1)) &&
      upper?.[key] == null;
    if (!isShadowed) {
      retained[key] = lower[key];
    }
  }
  return { ...retained, ...upper };
}

export function getEndpointFileConfig(params: {
  fileConfig?: FileConfig | null;
  endpoint?: string | null;
  endpointType?: string | null;
}): EndpointFileConfig {
  const { fileConfig: mergedFileConfig, endpoint, endpointType } = params;

  if (!mergedFileConfig?.endpoints) {
    return fileConfig.endpoints.default;
  }

  /** Compute an effective default by merging user-configured default over the base default */
  const baseDefaultConfig: EndpointFileConfig = fileConfig.endpoints.default;
  const globalDefaultConfig: EndpointFileConfig = {
    ...baseDefaultConfig,
    defaultLLMDeliveryPath: mergeDeliveryPathConfig(
      mergedFileConfig.defaultLLMDeliveryPath,
      baseDefaultConfig.defaultLLMDeliveryPath,
    ),
    legacyFileUploadUX: mergedFileConfig.legacyFileUploadUX ?? baseDefaultConfig.legacyFileUploadUX,
    textFallbackWithoutTools:
      mergedFileConfig.textFallbackWithoutTools ?? baseDefaultConfig.textFallbackWithoutTools,
  };
  const userDefaultConfig = mergedFileConfig.endpoints.default;
  const defaultConfig = userDefaultConfig
    ? mergeWithDefault(userDefaultConfig, globalDefaultConfig, 'default')
    : globalDefaultConfig;

  const normalizedEndpoint = normalizeEndpointName(endpoint ?? '');
  const standardEndpoints = new Set([
    'default',
    EModelEndpoint.agents,
    EModelEndpoint.assistants,
    EModelEndpoint.azureAssistants,
    EModelEndpoint.openAI,
    EModelEndpoint.azureOpenAI,
    EModelEndpoint.anthropic,
    EModelEndpoint.google,
    EModelEndpoint.bedrock,
  ]);

  const normalizedEndpointType = normalizeEndpointName(endpointType ?? '');
  const isCustomEndpoint =
    endpointType === EModelEndpoint.custom ||
    (!standardEndpoints.has(normalizedEndpointType) &&
      normalizedEndpoint &&
      !standardEndpoints.has(normalizedEndpoint));

  if (isCustomEndpoint) {
    /** 1. Check direct endpoint lookup (could be normalized or not) */
    if (endpoint && mergedFileConfig.endpoints[endpoint]) {
      return mergeWithDefault(mergedFileConfig.endpoints[endpoint], defaultConfig, endpoint);
    }
    /** 2. Check normalized endpoint lookup (skip standard endpoint keys) */
    for (const key in mergedFileConfig.endpoints) {
      if (!standardEndpoints.has(key) && normalizeEndpointName(key) === normalizedEndpoint) {
        return mergeWithDefault(mergedFileConfig.endpoints[key], defaultConfig, key);
      }
    }
    /** 3. Fallback to generic 'custom' config if any */
    if (mergedFileConfig.endpoints[EModelEndpoint.custom]) {
      return mergeWithDefault(
        mergedFileConfig.endpoints[EModelEndpoint.custom],
        defaultConfig,
        endpoint,
      );
    }
    /** 4. Fallback to 'agents' (all custom endpoints are non-assistants) */
    if (mergedFileConfig.endpoints[EModelEndpoint.agents]) {
      return mergeWithDefault(
        mergedFileConfig.endpoints[EModelEndpoint.agents],
        defaultConfig,
        endpoint,
      );
    }
    /** 5. Fallback to default */
    return defaultConfig;
  }

  /** Check endpointType first (most reliable for standard endpoints) */
  if (endpointType && mergedFileConfig.endpoints[endpointType]) {
    return mergeWithDefault(mergedFileConfig.endpoints[endpointType], defaultConfig, endpointType);
  }

  /** Check direct endpoint lookup */
  if (endpoint && mergedFileConfig.endpoints[endpoint]) {
    return mergeWithDefault(mergedFileConfig.endpoints[endpoint], defaultConfig, endpoint);
  }

  /** Check normalized endpoint */
  if (normalizedEndpoint && mergedFileConfig.endpoints[normalizedEndpoint]) {
    return mergeWithDefault(
      mergedFileConfig.endpoints[normalizedEndpoint],
      defaultConfig,
      normalizedEndpoint,
    );
  }

  /** Fallback to agents if endpoint is explicitly agents */
  const isAgents = isAgentsEndpoint(normalizedEndpointType || normalizedEndpoint);
  if (isAgents && mergedFileConfig.endpoints[EModelEndpoint.agents]) {
    return mergeWithDefault(
      mergedFileConfig.endpoints[EModelEndpoint.agents],
      defaultConfig,
      EModelEndpoint.agents,
    );
  }

  /** Return default config */
  return defaultConfig;
}

export function mergeFileConfig(dynamic: DynamicFileConfig | undefined): FileConfig {
  if (!dynamic) {
    return (staticMergedConfig ??= buildMergedFileConfig(undefined));
  }
  let merged = mergedConfigCache.get(dynamic);
  if (!merged) {
    merged = buildMergedFileConfig(dynamic);
    mergedConfigCache.set(dynamic, merged);
  }
  return merged;
}

function buildMergedFileConfig(dynamic: DynamicFileConfig | undefined): FileConfig {
  const mergedConfig: FileConfig = {
    ...fileConfig,
    endpoints: {
      ...fileConfig.endpoints,
    },
    skills: {
      ...fileConfig.skills,
    },
    ocr: {
      ...fileConfig.ocr,
      supportedMimeTypes: fileConfig.ocr?.supportedMimeTypes || [],
    },
    text: {
      ...fileConfig.text,
      supportedMimeTypes: fileConfig.text?.supportedMimeTypes || [],
    },
    stt: {
      ...fileConfig.stt,
      supportedMimeTypes: fileConfig.stt?.supportedMimeTypes || [],
    },
  };
  if (!dynamic) {
    return mergedConfig;
  }

  if (dynamic.retentionHours !== undefined) {
    mergedConfig.retentionHours = dynamic.retentionHours;
  }

  if (dynamic.defaultLLMDeliveryPath !== undefined) {
    mergedConfig.defaultLLMDeliveryPath = dynamic.defaultLLMDeliveryPath;
  }

  if (dynamic.legacyFileUploadUX !== undefined) {
    mergedConfig.legacyFileUploadUX = dynamic.legacyFileUploadUX;
  }

  if (dynamic.textFallbackWithoutTools !== undefined) {
    mergedConfig.textFallbackWithoutTools = dynamic.textFallbackWithoutTools;
  }

  if (dynamic.serverFileSizeLimit !== undefined) {
    mergedConfig.serverFileSizeLimit = mbToBytes(dynamic.serverFileSizeLimit);
  }

  if (dynamic.avatarSizeLimit !== undefined) {
    mergedConfig.avatarSizeLimit = mbToBytes(dynamic.avatarSizeLimit);
  }

  if (dynamic.fileTokenLimit !== undefined) {
    mergedConfig.fileTokenLimit = dynamic.fileTokenLimit;
  }

  if (dynamic.fileContextSizeLimit !== undefined) {
    mergedConfig.fileContextSizeLimit = mbToBytes(dynamic.fileContextSizeLimit);
  }

  if (dynamic.fileContextCharLimit !== undefined) {
    mergedConfig.fileContextCharLimit = dynamic.fileContextCharLimit;
  }

  if (dynamic.skills?.importCleanupConcurrency !== undefined) {
    mergedConfig.skills = {
      ...mergedConfig.skills,
      importCleanupConcurrency: dynamic.skills.importCleanupConcurrency,
    };
  }

  if (dynamic.skills?.fileSizeLimit !== undefined) {
    mergedConfig.skills = {
      ...mergedConfig.skills,
      fileSizeLimit: mbToBytes(dynamic.skills.fileSizeLimit),
    };
  }

  // Merge clientImageResize configuration; an admin-provided `enabled` overrides the user's setting
  if (dynamic.clientImageResize !== undefined) {
    mergedConfig.clientImageResize = {
      ...mergedConfig.clientImageResize,
      ...dynamic.clientImageResize,
      enforced: dynamic.clientImageResize.enabled !== undefined,
    };
  }

  if (dynamic.ocr !== undefined) {
    const { supportedMimeTypes: ocrMimeTypes, ...ocrRest } = dynamic.ocr;
    mergedConfig.ocr = {
      ...mergedConfig.ocr,
      ...ocrRest,
    };
    if (ocrMimeTypes) {
      mergedConfig.ocr.supportedMimeTypes = convertStringsToRegex(ocrMimeTypes);
    }
  }

  if (dynamic.text !== undefined) {
    const { supportedMimeTypes: textMimeTypes, ...textRest } = dynamic.text;
    mergedConfig.text = {
      ...mergedConfig.text,
      ...textRest,
    };
    if (textMimeTypes) {
      mergedConfig.text.supportedMimeTypes = convertStringsToRegex(textMimeTypes);
    }
  }

  if (!dynamic.endpoints) {
    return mergedConfig;
  }

  for (const key in dynamic.endpoints) {
    const dynamicEndpoint = (dynamic.endpoints as Record<string, EndpointFileConfig>)[key];

    /** Deep copy the base endpoint config if it exists to prevent mutation */
    if (!mergedConfig.endpoints[key]) {
      mergedConfig.endpoints[key] = {};
    } else {
      mergedConfig.endpoints[key] = { ...mergedConfig.endpoints[key] };
    }

    const mergedEndpoint = mergedConfig.endpoints[key];

    if (dynamicEndpoint.disabled === true) {
      mergedEndpoint.disabled = true;
      mergedEndpoint.fileLimit = 0;
      mergedEndpoint.fileSizeLimit = 0;
      mergedEndpoint.totalSizeLimit = 0;
      mergedEndpoint.supportedMimeTypes = [];
      continue;
    }

    if (dynamicEndpoint.fileSizeLimit !== undefined) {
      mergedEndpoint.fileSizeLimit = mbToBytes(dynamicEndpoint.fileSizeLimit);
    }

    if (dynamicEndpoint.totalSizeLimit !== undefined) {
      mergedEndpoint.totalSizeLimit = mbToBytes(dynamicEndpoint.totalSizeLimit);
    }

    const configKeys = ['fileLimit'] as const;
    configKeys.forEach((field) => {
      if (dynamicEndpoint[field] !== undefined) {
        mergedEndpoint[field] = dynamicEndpoint[field];
      }
    });

    if (dynamicEndpoint.disabled !== undefined) {
      mergedEndpoint.disabled = dynamicEndpoint.disabled;
    }

    if (dynamicEndpoint.supportedMimeTypes) {
      mergedEndpoint.supportedMimeTypes = convertStringsToRegex(
        dynamicEndpoint.supportedMimeTypes as unknown as string[],
      );
    }

    if (dynamicEndpoint.defaultLLMDeliveryPath !== undefined) {
      mergedEndpoint.defaultLLMDeliveryPath = dynamicEndpoint.defaultLLMDeliveryPath;
    }

    if (dynamicEndpoint.legacyFileUploadUX !== undefined) {
      mergedEndpoint.legacyFileUploadUX = dynamicEndpoint.legacyFileUploadUX;
    }

    if (dynamicEndpoint.textFallbackWithoutTools !== undefined) {
      mergedEndpoint.textFallbackWithoutTools = dynamicEndpoint.textFallbackWithoutTools;
    }
  }

  return mergedConfig;
}
