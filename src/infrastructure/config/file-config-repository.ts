/**
 * FileConfigRepository — the persistence adapter for the ACL config file. The
 * SINGLE place that reads AND writes the config on disk, so runtime reads and
 * setup writes share one validation pipeline and can never drift.
 *
 *  - load(): parse -> Zod-validate -> STATIC scope-lint -> map to DOMAIN. The only
 *    query the `ConfigRepository` port exposes; FAIL-CLOSED on any failure
 *    (default-deny). Config is READ-ONLY at runtime.
 *  - save(config): the inverse, used ONLY by the interactive `setup` generator.
 *    Re-validates + re-lints the serialized form (so we never persist a file
 *    load() would reject), then writes it ATOMICALLY with 0600 perms and returns
 *    the exact committed bytes for authenticated publication.
 *
 * Error model: config failures (file/JSON/schema/lint/mapping/write) surface as a
 * non-Telegram `VALIDATION` AppError carrying NO Telegram concern (no FloodWait /
 * retry-after), so a config problem is never mistaken for a gateway problem.
 *
 * No GramJS, no secrets in logs. Warnings go to STDERR (stdout is reserved for
 * the MCP protocol on the stdio transport).
 */
import { atomicWrite } from '../atomic-write.js';
import { FileTooLargeError, hasErrnoCode, readUtf8Bounded } from '../bounded-read.js';
import { err, isErr, ok } from '../../shared/index.js';
import type { Result } from '../../shared/index.js';
import { appError, AppErrorCode } from '../../application/index.js';
import type {
  AppError,
  ConfigDocumentParser,
  ConfigRepository,
  LoadedConfiguration,
} from '../../application/index.js';
import {
  chatEntryToRef,
  configSchema,
  folderEntryValue,
  hasLintErrors,
  lintConfig,
  mapConfigToDomain,
} from '../../config/index.js';
import type { LintFinding, ValidatedConfig } from '../../config/index.js';
import type { DeclaredChatVerbOverride } from '../../domain/index.js';

const describeFinding = (finding: LintFinding): string => {
  const prefix =
    finding.endpoint !== undefined ? `endpoint '${finding.endpoint}': ` : '';
  return `${prefix}${finding.message}`;
};

// ---------------------------------------------------------------------------
// The SHARED validation pipeline. Takes an ALREADY-PARSED JSON value
// (Zod-validate -> STATIC scope-lint -> map to DOMAIN) and never touches disk, so
// both the plain read path (`FileConfigRepository.load`) and the sealed-policy
// repo (which JSON-parses the decrypted policy bytes) run the EXACT same
// schema/lint/map — they can never drift. Fail-closed.
// ---------------------------------------------------------------------------

/**
 * Validate + scope-lint + map a parsed config document into domain objects.
 * `warn` receives non-fatal lint warnings (defaults to a no-op). Every failure
 * surfaces as a non-Telegram `VALIDATION` AppError.
 */
interface ParsedConfigDocument {
  readonly config: ValidatedConfig;
  readonly loaded: LoadedConfiguration;
}

const decodeConfigDocument = (
  json: unknown,
  warn: (message: string) => void = (): undefined => undefined,
): Result<ParsedConfigDocument, AppError> => {
  const parsed = configSchema.safeParse(json);
  if (!parsed.success) {
    const summary = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    return err(
      appError(AppErrorCode.Validation, `Invalid config: ${summary}`),
    );
  }

  const findings = lintConfig(parsed.data);
  for (const finding of findings) {
    if (finding.level === 'warn') {
      warn(describeFinding(finding));
    }
  }
  if (hasLintErrors(findings)) {
    const summary = findings
      .filter((finding) => finding.level === 'error')
      .map(describeFinding)
      .join('; ');
    return err(
      appError(AppErrorCode.Validation, `Scope-lint failed: ${summary}`),
    );
  }

  const mapped = mapConfigToDomain(parsed.data);
  if (isErr(mapped)) {
    return err(
      appError(AppErrorCode.Validation, mapped.error.message, {
        cause: mapped.error,
      }),
    );
  }

  return ok({
    config: parsed.data,
    loaded: {
      endpoints: mapped.value.endpoints,
      killSwitch: { disabledVerbs: new Set(mapped.value.disabledVerbs) },
      ...(mapped.value.maxDownloadBytes !== undefined
        ? { maxDownloadBytes: mapped.value.maxDownloadBytes }
        : {}),
    },
  });
};

/** Validate a parsed document and retain its normalised, editable config DTO. */
const parseValidatedConfigDocument = (
  json: unknown,
  warn?: (message: string) => void,
): Result<ValidatedConfig, AppError> => {
  const parsed = decodeConfigDocument(json, warn);
  return isErr(parsed) ? parsed : ok(parsed.value.config);
};

/** Validate a parsed document and expose only the runtime domain projection. */
export const parseConfigDocument = (
  json: unknown,
  warn?: (message: string) => void,
): Result<LoadedConfiguration, AppError> => {
  const parsed = decodeConfigDocument(json, warn);
  return isErr(parsed) ? parsed : ok(parsed.value.loaded);
};

// ---------------------------------------------------------------------------
// On-disk serialization — the inverse of the Zod schema's input transforms.
// The file uses the ergonomic, human-readable shorthand ('me', '@user', a
// numeric id; folder id-or-title) so a round-trip through the schema reproduces
// the same ValidatedConfig (lossless).
// ---------------------------------------------------------------------------

/**
 * Re-emit the per-chat overrides as the on-disk record `{ "<chatRef>": [...] }`,
 * the inverse of `chatOverridesSchema`'s transform. Returns `undefined` when
 * empty so the field is dropped from the file (keeps no-override configs
 * byte-stable). Lossless: re-parsing reproduces the same normalised overrides.
 */
const serializeChatOverrides = (
  overrides: readonly DeclaredChatVerbOverride[],
): Readonly<Record<string, readonly string[]>> | undefined => {
  if (overrides.length === 0) {
    return undefined;
  }
  const record: Record<string, readonly string[]> = {};
  for (const override of overrides) {
    record[chatEntryToRef(override.peer)] = [...override.verbs];
  }
  return record;
};

const serializeScope = (
  scope: ValidatedConfig['endpoints'][number]['scope'],
): {
  readonly chats: readonly string[];
  readonly folders: readonly (number | string)[];
  readonly chatOverrides?: Readonly<Record<string, readonly string[]>>;
} => {
  const chatOverrides = serializeChatOverrides(scope.chatOverrides);
  return {
    chats: scope.chats.map(chatEntryToRef),
    folders: scope.folders.map(folderEntryValue),
    ...(chatOverrides !== undefined ? { chatOverrides } : {}),
  };
};

const toFileShape = (config: ValidatedConfig): object => ({
  version: 1,
  killSwitch: { disabledVerbs: [...config.killSwitch.disabledVerbs] },
  // Emit only when set, so a config without the override stays byte-stable on re-save.
  ...(config.maxDownloadBytes !== undefined
    ? { maxDownloadBytes: config.maxDownloadBytes }
    : {}),
  endpoints: config.endpoints.map((endpoint) => ({
    name: endpoint.name,
    session: endpoint.session,
    scope: serializeScope(endpoint.scope),
    verbs: [...endpoint.verbs],
    hitl: { confirmWrites: endpoint.hitl.confirmWrites },
    tokenHash: endpoint.tokenHash,
  })),
});

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export interface FileConfigRepositoryOptions {
  readonly filePath: string;
  /** Sink for non-fatal lint warnings; defaults to stderr. */
  readonly warn?: (message: string) => void;
}

const MISSING_CONFIG = Symbol('missing config');

export class FileConfigRepository implements ConfigRepository, ConfigDocumentParser {
  private readonly warn: (message: string) => void;

  public constructor(private readonly options: FileConfigRepositoryOptions) {
    this.warn =
      options.warn ??
      ((message: string): void => {
        process.stderr.write(`[config][warn] ${message}\n`);
      });
  }

  /**
   * Parse + validate + scope-lint the config into domain objects; read-only at
   * daemon startup. Fail-closed to a `VALIDATION` AppError on any failure.
   */
  public async load(): Promise<Result<LoadedConfiguration, AppError>> {
    const document = await this.readDocument(
      `Config file not readable at ${this.options.filePath}`,
    );
    if (isErr(document)) return document;
    if (document.value === MISSING_CONFIG) {
      return err(
        appError(
          AppErrorCode.Validation,
          `Config file not readable at ${this.options.filePath}`,
        ),
      );
    }
    return parseConfigDocument(document.value, this.warn);
  }

  /**
   * Validate an ALREADY-PARSED config document (the `ConfigDocumentParser` port).
   * Used by the sealed-policy repo AFTER it decrypts + parses the sealed bytes,
   * so the verified object is the validated object.
   */
  public loadFromParsed(json: unknown): Result<LoadedConfiguration, AppError> {
    return parseConfigDocument(json, this.warn);
  }

  /**
   * Load + validate the on-disk document, retaining the normalised editable DTO
   * (the `setup` editing baseline). `ok(undefined)` when the file does not
   * exist (a first run — the ONLY non-error miss); any other failure —
   * unreadable, oversized, malformed JSON, schema/lint/domain-invalid — is a
   * fail-closed `VALIDATION` error, so a caller can never adopt a
   * silently-empty baseline and clobber the real config on its next save.
   */
  public async loadValidated(): Promise<
    Result<ValidatedConfig | undefined, AppError>
  > {
    const document = await this.readDocument(
      `could not read the config file at ${this.options.filePath} — fix its permissions (or move it)`,
    );
    if (isErr(document)) return document;
    if (document.value === MISSING_CONFIG) return ok(undefined);
    return parseValidatedConfigDocument(document.value, this.warn);
  }

  /**
   * Losslessly persist a validated config — the ONE public write (used by
   * `setup`). FAIL-CLOSED: round-trips the serialized form through
   * {@link parseConfigDocument} — the EXACT schema/lint/domain pipeline `load()`
   * runs — so a file this method writes can never be one `load()` later rejects
   * (a schema-only check here once let a `@x`-style ref through that the domain
   * mapping then refused).
   */
  public async save(
    config: ValidatedConfig,
  ): Promise<Result<string, AppError>> {
    const shape = toFileShape(config);
    const validated = parseValidatedConfigDocument(shape, this.warn);
    if (isErr(validated)) {
      return err(
        appError(
          AppErrorCode.Validation,
          `Refusing to write a config the runtime would reject: ${validated.error.message}`,
        ),
      );
    }

    const serialized = `${JSON.stringify(shape, null, 2)}\n`;
    const written = await atomicWrite(this.options.filePath, serialized);
    return isErr(written) ? written : ok(serialized);
  }

  private async readDocument(
    readFailure: string,
  ): Promise<Result<unknown, AppError>> {
    let raw: string;
    try {
      raw = await readUtf8Bounded(this.options.filePath);
    } catch (e) {
      if (hasErrnoCode(e, 'ENOENT')) return ok(MISSING_CONFIG);
      if (e instanceof FileTooLargeError) {
        return err(
          appError(AppErrorCode.Validation, 'Config file exceeds the size ceiling'),
        );
      }
      return err(
        appError(AppErrorCode.Validation, readFailure),
      );
    }

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return err(
        appError(AppErrorCode.Validation, 'Config file is not valid JSON'),
      );
    }

    return ok(json);
  }
}
