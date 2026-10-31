/** catalog.ts owns provider routing facts and canonical MIME/extension catalogs. */
import type { ResponsesApiRouting } from '../types';
import { gpt6Tier, gptPointReleaseFamily } from '../families';
import { EModelEndpoint } from '../schemas';

/** Parallel storage deletions during rollback of a failed skill archive import. */
export const DEFAULT_SKILL_IMPORT_CLEANUP_CONCURRENCY = 8;

export const supportsFiles = {
  [EModelEndpoint.openAI]: true,
  [EModelEndpoint.google]: true,
  [EModelEndpoint.assistants]: true,
  [EModelEndpoint.azureAssistants]: true,
  [EModelEndpoint.agents]: true,
  [EModelEndpoint.azureOpenAI]: true,
  [EModelEndpoint.anthropic]: true,
  [EModelEndpoint.custom]: true,
  [EModelEndpoint.bedrock]: true,
};

export const excelFileTypes = [
  'application/vnd.ms-excel',
  'application/msexcel',
  'application/x-msexcel',
  'application/x-ms-excel',
  'application/x-excel',
  'application/x-dos_ms_excel',
  'application/xls',
  'application/x-xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];

export const fullMimeTypesList = [
  'text/x-c',
  'text/x-c++',
  'application/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/html',
  'text/x-java',
  'application/json',
  'text/markdown',
  'application/pdf',
  'text/x-php',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.presentationml.template',
  'text/x-python',
  'text/x-script.python',
  'text/x-ruby',
  'text/x-tex',
  'text/plain',
  'text/css',
  'text/calendar',
  'text/vtt',
  'image/jpeg',
  'text/javascript',
  'image/gif',
  'image/png',
  'image/heic',
  'image/heif',
  'application/x-tar',
  'application/x-sh',
  'application/typescript',
  'application/sql',
  'application/yaml',
  'application/vnd.coffeescript',
  'application/xml',
  'application/zip',
  'application/x-zip-compressed',
  'application/x-parquet',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
  'application/vnd.oasis.opendocument.graphics',
  'image/svg',
  'image/svg+xml',
  'message/rfc822',
  // Video formats
  'video/mp4',
  'video/avi',
  'video/mov',
  'video/wmv',
  'video/flv',
  'video/webm',
  'video/mkv',
  'video/m4v',
  'video/3gp',
  'video/ogv',
  // Audio formats
  'audio/mp3',
  'audio/wav',
  'audio/ogg',
  'audio/m4a',
  'audio/aac',
  'audio/flac',
  'audio/wma',
  'audio/opus',
  'audio/mpeg',
  ...excelFileTypes,
];

export const codeInterpreterMimeTypesList = [
  'text/x-c',
  'text/x-c++',
  'application/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/html',
  'text/x-java',
  'application/json',
  'text/markdown',
  'application/pdf',
  'text/x-php',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.presentationml.template',
  'text/x-python',
  'text/x-script.python',
  'text/x-ruby',
  'text/x-tex',
  'text/plain',
  'text/css',
  'text/calendar',
  'image/jpeg',
  'text/javascript',
  'image/gif',
  'image/png',
  'image/heic',
  'image/heif',
  'application/x-tar',
  'application/typescript',
  'application/xml',
  'application/zip',
  'application/x-zip-compressed',
  'application/x-parquet',
  ...excelFileTypes,
];

export const retrievalMimeTypesList = [
  'text/x-c',
  'text/x-c++',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/html',
  'text/x-java',
  'application/json',
  'text/markdown',
  'application/pdf',
  'text/x-php',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.presentationml.template',
  'text/x-python',
  'text/x-script.python',
  'text/x-ruby',
  'text/x-tex',
  'text/plain',
];

export const imageExtRegex = /\.(jpg|jpeg|png|gif|webp|heic|heif)$/i;

/** @see https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_DocumentBlock.html */
export type BedrockDocumentFormat =
  | 'pdf'
  | 'csv'
  | 'doc'
  | 'docx'
  | 'xls'
  | 'xlsx'
  | 'html'
  | 'txt'
  | 'md';

/** Maps MIME types to Bedrock Converse API document format values */
export const bedrockDocumentFormats: Record<string, BedrockDocumentFormat> = {
  'application/pdf': 'pdf',
  'text/csv': 'csv',
  'application/csv': 'csv',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/html': 'html',
  'text/plain': 'txt',
  'text/markdown': 'md',
};

/**
 * Whether an upload belongs to the conversation rather than to the agent. The value
 * arrives from multipart form data, so it can be the string "false", which is truthy.
 * Shared so the route, the authorization check and processing cannot disagree about it.
 */
export const isMessageFileUpload = (value?: boolean | string | null): boolean =>
  value === true || value === 'true';

/**
 * Whether the upload's conversation uses the Responses API, which decides whether Azure
 * can carry a document natively. Multipart form data has no booleans, so it arrives as
 * the string "true".
 */
export const isResponsesApiUpload = (value?: boolean | string | null): boolean =>
  value === true || value === 'true';

/**
 * The name a file carries inside the code sandbox.
 *
 * Image uploads are converted to the configured output type while the record keeps the
 * original filename, so the extension has to follow the stored bytes or the sandbox
 * decoder is handed a mismatch. Provisioning and priming both resolve the mount path
 * from here: deriving it twice under different rules leaves a later turn advertising a
 * path that does not exist in the sandbox.
 */
export const resolveSandboxFilename = (filename: string, mimeType?: string | null): string => {
  if (!mimeType?.startsWith('image/')) {
    return filename;
  }
  const subtype = mimeType.slice('image/'.length);
  if (!['webp', 'png', 'jpeg', 'gif'].includes(subtype)) {
    return filename;
  }
  const accepted = subtype === 'jpeg' ? ['.jpg', '.jpeg'] : [`.${subtype}`];
  const lastDot = filename.lastIndexOf('.');
  const currentExt = lastDot > 0 ? filename.slice(lastDot).toLowerCase() : '';
  if (accepted.includes(currentExt)) {
    return filename;
  }
  const base = lastDot > 0 ? filename.slice(0, lastDot) : filename;
  return `${base}${accepted[0]}`;
};

/**
 * The Responses setting a turn actually runs on. A saved agent's own record wins, since
 * execution reads its model parameters; a conversation only answers for itself. Upload
 * and delivery must agree here, or a document is stored as raw provider content and then
 * re-resolved to text it has no extraction for.
 */
export const resolveUseResponsesApi = (
  agentValue?: boolean | null,
  conversationValue?: boolean | null,
): boolean | undefined => agentValue ?? conversationValue ?? undefined;

/** Models whose native OpenAI and Azure execution defaults to Responses. Keep
 * this shared with client upload routing so documents follow the API that the
 * backend will actually invoke. Explicit false remains an opt-out. */
export const prefersResponsesApiByModel = (model?: string | null): boolean =>
  gpt6Tier(model) != null;

/** The server has transport and administrator settings the browser cannot see.
 * Missing policy never enables model-based uploads (including during upgrades). */
export const resolveEffectiveUseResponsesApi = ({
  value,
  endpoint,
  model,
  routing,
  webSearch,
}: {
  value?: boolean | null;
  endpoint?: string | null;
  model?: string | null;
  routing?: ResponsesApiRouting;
  webSearch?: boolean | null;
}): boolean | undefined => {
  if (endpoint !== EModelEndpoint.openAI && endpoint !== EModelEndpoint.azureOpenAI) {
    return value ?? undefined;
  }
  let policy = model ? routing?.[model] : undefined;
  /** A native point release follows its family until the server lists it. Azure
   * routing is keyed by configured deployments, so a family's policy there says
   * nothing about a release that is not deployed. */
  const releaseFamily =
    endpoint === EModelEndpoint.openAI && model ? gptPointReleaseFamily(model) : undefined;
  if (!policy && releaseFamily) {
    policy = routing?.[releaseFamily];
  }
  const tier = gpt6Tier(model);
  if (!policy && tier) {
    policy = routing?.[`gpt-6-${tier}-*`];
  }
  policy ??= routing?.['*'];
  if (!policy) return value ?? undefined;
  if (webSearch && policy.withWebSearch) policy = policy.withWebSearch;
  if (value == null) return policy.default;
  return value ? policy.on : policy.off;
};

export const isBedrockDocumentType = (mimeType?: string): boolean =>
  mimeType != null && mimeType in bedrockDocumentFormats;

/** MIME types Bedrock's Converse document path can send to the model (mirrors `bedrockDocumentFormats`). */
export const bedrockDocumentMimeTypes: readonly string[] = Object.keys(bedrockDocumentFormats);

/** File extensions accepted by Bedrock document uploads (for input accept attributes) */
export const bedrockDocumentExtensions =
  '.pdf,.csv,.doc,.docx,.xls,.xlsx,.html,.htm,.txt,.md,application/pdf,text/csv,application/csv,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/html,text/plain,text/markdown';

/** Textual `application/*` MIME types that can be decoded and sent as plain text */
const textualApplicationTypes = new Set([
  'application/json',
  'application/xml',
  'application/yaml',
  'application/sql',
  'application/typescript',
  'application/x-sh',
  'application/csv',
]);

/**
 * MIME types the Anthropic Messages API accepts as a plain-text document source
 * (`source.type: 'text'`)
 */
export const isAnthropicTextDocumentType = (mimeType?: string): boolean =>
  mimeType != null && (mimeType.startsWith('text/') || textualApplicationTypes.has(mimeType));

/**
 * MIME types the Anthropic Messages API document path can send to the model
 * (mirrors `isBedrockDocumentType`): PDF via base64, textual types via a
 * plain-text document source. All other types are rejected with a provider 400.
 */
export const isAnthropicDocumentType = (mimeType?: string): boolean =>
  mimeType === 'application/pdf' || isAnthropicTextDocumentType(mimeType);

export const excelMimeTypes =
  /^application\/(vnd\.ms-excel|msexcel|x-msexcel|x-ms-excel|x-excel|x-dos_ms_excel|xls|x-xls|vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet)$/;

export const textMimeTypes =
  /^(text\/(x-c|x-csharp|tab-separated-values|x-c\+\+|x-h|x-java|html|markdown|x-php|x-python|x-script\.python|x-ruby|x-tex|plain|css|vtt|javascript|csv|xml|calendar))$/;

export const applicationMimeTypes =
  /^(application\/(epub\+zip|csv|json|msword|pdf|x-tar|x-sh|x-zip-compressed|typescript|sql|yaml|x-parquet|vnd\.apache\.parquet|vnd\.coffeescript|vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|presentationml\.(presentation|template)|spreadsheetml\.sheet)|vnd\.oasis\.opendocument\.(text|spreadsheet|presentation|graphics)|xml|zip))$/;

export const imageMimeTypes = /^image\/(jpeg|gif|png|webp|heic|heif)$/;

export const audioMimeTypes =
  /^audio\/(mp3|mpeg|mpeg3|wav|wave|x-wav|ogg|vorbis|mp4|m4a|x-m4a|flac|x-flac|webm|aac|wma|opus)$/;

export const videoMimeTypes = /^video\/(mp4|avi|mov|wmv|flv|webm|mkv|m4v|3gp|ogv)$/;

export const defaultOCRMimeTypes = [
  imageMimeTypes,
  excelMimeTypes,
  /^application\/pdf$/,
  /^application\/vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|presentationml\.presentation)$/,
  /^application\/vnd\.openxmlformats-officedocument\.presentationml\.template$/,
  /^application\/vnd\.ms-(word|powerpoint)$/,
  /^application\/epub\+zip$/,
  /^application\/vnd\.oasis\.opendocument\.(text|spreadsheet|presentation|graphics)$/,
];

/** MIME types handled by the built-in document parser (pdf, docx, excel variants, ods/odt) */
export const documentParserMimeTypes = [
  excelMimeTypes,
  /^application\/pdf$/,
  /^application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document$/,
  /^application\/vnd\.oasis\.opendocument\.spreadsheet$/,
  /^application\/vnd\.oasis\.opendocument\.text$/,
];

export const defaultTextMimeTypes = [/^[\w.-]+\/[\w.-]+$/];

export const defaultSTTMimeTypes = [audioMimeTypes];

export const supportedMimeTypes = [
  textMimeTypes,
  excelMimeTypes,
  applicationMimeTypes,
  imageMimeTypes,
  videoMimeTypes,
  audioMimeTypes,
  /** Supported by LC Code Interpreter API */
  /^image\/(svg|svg\+xml)$/,
  /** .eml email files */
  /^message\/rfc822$/,
];

export const codeInterpreterMimeTypes = [
  textMimeTypes,
  excelMimeTypes,
  applicationMimeTypes,
  imageMimeTypes,
];

export const codeTypeMapping: { [key: string]: string } = {
  c: 'text/x-c', // .c - C source
  cs: 'text/x-csharp', // .cs - C# source
  cpp: 'text/x-c++', // .cpp - C++ source
  h: 'text/x-h', // .h - C/C++ header
  md: 'text/markdown', // .md - Markdown
  php: 'text/x-php', // .php - PHP source
  py: 'text/x-python', // .py - Python source
  rb: 'text/x-ruby', // .rb - Ruby source
  tex: 'text/x-tex', // .tex - LaTeX source
  java: 'text/x-java', // .java - Java source
  js: 'text/javascript', // .js - JavaScript source
  sh: 'application/x-sh', // .sh - Shell script
  ts: 'application/typescript', // .ts - TypeScript source
  tar: 'application/x-tar', // .tar - Tar archive
  zip: 'application/zip', // .zip - ZIP archive
  txt: 'text/plain', // .txt - Plain text file
  log: 'text/plain', // .log - Log file
  csv: 'text/csv', // .csv - Comma-separated values
  tsv: 'text/tab-separated-values', // .tsv - Tab-separated values
  parquet: 'application/x-parquet', // .parquet - Apache Parquet columnar storage
  json: 'application/json', // .json - JSON file
  xml: 'application/xml', // .xml - XML file
  html: 'text/html', // .html - HTML file
  htm: 'text/html', // .htm - HTML file
  css: 'text/css', // .css - CSS file
  yml: 'application/yaml', // .yml - YAML
  yaml: 'application/yaml', // .yaml - YAML
  sql: 'application/sql', // .sql - SQL (IANA registered)
  dart: 'text/plain', // .dart - Dart source
  coffee: 'application/vnd.coffeescript', // .coffee - CoffeeScript (IANA registered)
  go: 'text/plain', // .go - Go source
  rs: 'text/plain', // .rs - Rust source
  swift: 'text/plain', // .swift - Swift source
  kt: 'text/plain', // .kt - Kotlin source
  kts: 'text/plain', // .kts - Kotlin script
  scala: 'text/plain', // .scala - Scala source
  lua: 'text/plain', // .lua - Lua source
  r: 'text/plain', // .r - R source
  pl: 'text/plain', // .pl - Perl source
  pm: 'text/plain', // .pm - Perl module
  groovy: 'text/plain', // .groovy - Groovy source
  gradle: 'text/plain', // .gradle - Gradle build script
  clj: 'text/plain', // .clj - Clojure source
  cljs: 'text/plain', // .cljs - ClojureScript source
  cljc: 'text/plain', // .cljc - Clojure common source
  elm: 'text/plain', // .elm - Elm source
  eml: 'message/rfc822', // .eml - Email message (RFC 822)
  erl: 'text/plain', // .erl - Erlang source
  hrl: 'text/plain', // .hrl - Erlang header
  ex: 'text/plain', // .ex - Elixir source
  exs: 'text/plain', // .exs - Elixir script
  hs: 'text/plain', // .hs - Haskell source
  lhs: 'text/plain', // .lhs - Literate Haskell source
  ml: 'text/plain', // .ml - OCaml source
  mli: 'text/plain', // .mli - OCaml interface
  fs: 'text/plain', // .fs - F# source
  fsx: 'text/plain', // .fsx - F# script
  lisp: 'text/plain', // .lisp - Lisp source
  cl: 'text/plain', // .cl - Common Lisp source
  scm: 'text/plain', // .scm - Scheme source
  rkt: 'text/plain', // .rkt - Racket source
  jsx: 'text/plain', // .jsx - React JSX
  tsx: 'text/plain', // .tsx - React TSX
  vue: 'text/plain', // .vue - Vue component
  svelte: 'text/plain', // .svelte - Svelte component
  astro: 'text/plain', // .astro - Astro component
  scss: 'text/plain', // .scss - SCSS source
  sass: 'text/plain', // .sass - Sass source
  less: 'text/plain', // .less - Less source
  styl: 'text/plain', // .styl - Stylus source
  toml: 'text/plain', // .toml - TOML config
  ini: 'text/plain', // .ini - INI config
  cfg: 'text/plain', // .cfg - Config file
  conf: 'text/plain', // .conf - Config file
  env: 'text/plain', // .env - Environment file
  properties: 'text/plain', // .properties - Java properties
  graphql: 'text/plain', // .graphql - GraphQL schema/query
  gql: 'text/plain', // .gql - GraphQL schema/query
  proto: 'text/plain', // .proto - Protocol Buffers
  dockerfile: 'text/plain', // Dockerfile
  makefile: 'text/plain', // Makefile
  cmake: 'text/plain', // .cmake - CMake script
  rake: 'text/plain', // .rake - Rake task
  gemspec: 'text/plain', // .gemspec - Ruby gem spec
  bash: 'text/plain', // .bash - Bash script
  zsh: 'text/plain', // .zsh - Zsh script
  fish: 'text/plain', // .fish - Fish script
  ps1: 'text/plain', // .ps1 - PowerShell script
  psm1: 'text/plain', // .psm1 - PowerShell module
  bat: 'text/plain', // .bat - Batch script
  cmd: 'text/plain', // .cmd - Windows command script
  asm: 'text/plain', // .asm - Assembly source
  s: 'text/plain', // .s - Assembly source
  v: 'text/plain', // .v - V or Verilog source
  zig: 'text/plain', // .zig - Zig source
  nim: 'text/plain', // .nim - Nim source
  cr: 'text/plain', // .cr - Crystal source
  d: 'text/plain', // .d - D source
  pas: 'text/plain', // .pas - Pascal source
  pp: 'text/plain', // .pp - Pascal/Puppet source
  f90: 'text/plain', // .f90 - Fortran 90 source
  f95: 'text/plain', // .f95 - Fortran 95 source
  f03: 'text/plain', // .f03 - Fortran 2003 source
  jl: 'text/plain', // .jl - Julia source
  m: 'text/plain', // .m - Objective-C/MATLAB source
  mm: 'text/plain', // .mm - Objective-C++ source
  ada: 'text/plain', // .ada - Ada source
  adb: 'text/plain', // .adb - Ada body
  ads: 'text/plain', // .ads - Ada spec
  cob: 'text/plain', // .cob - COBOL source
  cbl: 'text/plain', // .cbl - COBOL source
  tcl: 'text/plain', // .tcl - Tcl source
  awk: 'text/plain', // .awk - AWK script
  sed: 'text/plain', // .sed - Sed script
  odt: 'application/vnd.oasis.opendocument.text', // .odt - OpenDocument Text
  ods: 'application/vnd.oasis.opendocument.spreadsheet', // .ods - OpenDocument Spreadsheet
  odp: 'application/vnd.oasis.opendocument.presentation', // .odp - OpenDocument Presentation
  odg: 'application/vnd.oasis.opendocument.graphics', // .odg - OpenDocument Graphics
  doc: 'application/msword', // .doc - Word (legacy)
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx - Word
  xls: 'application/vnd.ms-excel', // .xls - Excel (legacy)
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx - Excel
  ppt: 'application/vnd.ms-powerpoint', // .ppt - PowerPoint (legacy)
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', // .pptx - PowerPoint
  potx: 'application/vnd.openxmlformats-officedocument.presentationml.template', // .potx - PowerPoint template
  ics: 'text/calendar', // .ics - iCalendar
  ical: 'text/calendar', // .ical - iCalendar
  ifb: 'text/calendar', // .ifb - iCalendar free/busy
  icalendar: 'text/calendar', // .icalendar - iCalendar
};

/** Maps image extensions to MIME types for formats browsers may not recognize */
export const imageTypeMapping: { [key: string]: string } = {
  heic: 'image/heic',
  heif: 'image/heif',
};

/** Normalizes non-standard MIME types that browsers may report to their canonical forms */
export const mimeTypeAliases: Readonly<Record<string, string>> = {
  'application/x-zip-compressed': 'application/zip',
  'text/x-python-script': 'text/x-python',
  'text/x-markdown': 'text/markdown',
  /** freedesktop shared-mime-info (Chrome on Linux) */
  'application/x-shellscript': 'application/x-sh',
  /** libmagic, i.e. `file --mime-type` */
  'text/x-shellscript': 'application/x-sh',
};

/**
 * Infers the MIME type from a file's extension when the browser doesn't recognize it,
 * and normalizes known non-standard MIME type aliases to their canonical forms.
 * @param fileName - The file name including its extension
 * @param currentType - The MIME type reported by the browser (may be empty string)
 * @returns The normalized or inferred MIME type; empty string if unresolvable
 */
export function inferMimeType(fileName: string, currentType: string): string {
  if (currentType) {
    return mimeTypeAliases[currentType] ?? currentType;
  }

  const extension = fileName.split('.').pop()?.toLowerCase() ?? '';
  return codeTypeMapping[extension] || imageTypeMapping[extension] || currentType;
}

export const retrievalMimeTypes = [
  /^(text\/(x-c|x-c\+\+|x-h|html|x-java|markdown|x-php|x-python|x-script\.python|x-ruby|x-tex|plain|vtt|xml))$/,
  /^(application\/(json|pdf|vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|presentationml\.(presentation|template))))$/,
];
