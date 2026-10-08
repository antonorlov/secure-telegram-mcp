/**
 * The single place that reads AND writes the config file, so runtime reads and setup writes
 * share one validation pipeline and cannot drift.
 * load(): parse -> Zod -> static scope-lint -> domain, fail-closed on any failure; config is
 * read-only at runtime. save() is used only by the interactive setup generator: it re-validates
 * the serialized form, writes atomically at 0600, and returns the exact committed bytes.
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

/**
 * The shared validation pipeline over an already-parsed value, so the plain read path and the
 * sealed-policy repo run the exact same schema, lint and mapping. Never touches disk;
 * fail-closed.
 */

// Every failure surfaces as a non-Telegram `VALIDATION` error.
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

const parseValidatedConfigDocument = (
  json: unknown,
  warn?: (message: string) => void,
): Result<ValidatedConfig, AppError> => {
  const parsed = decodeConfigDocument(json, warn);
  return isErr(parsed) ? parsed : ok(parsed.value.config);
};

export const parseConfigDocument = (
  json: unknown,
  warn?: (message: string) => void,
): Result<LoadedConfiguration, AppError> => {
  const parsed = decodeConfigDocument(json, warn);
  return isErr(parsed) ? parsed : ok(parsed.value.loaded);
};

// On-disk serialization, the inverse of the schema's input transforms. The file keeps the
// ergonomic shorthand, so a round-trip through the schema reproduces the same ValidatedConfig.

// Returns `undefined` when empty, so the field is dropped and a no-override config stays
// byte-stable.
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

export interface FileConfigRepositoryOptions {
  readonly filePath: string;
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

  // Read-only at daemon startup; fail-closed to a `VALIDATION` error.
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

  // Used by the sealed-policy repo after it decrypts and parses the blob, so the verified
  // object is the validated object.
  public loadFromParsed(json: unknown): Result<LoadedConfiguration, AppError> {
    return parseConfigDocument(json, this.warn);
  }

  /**
   * `ok(undefined)` only when the file does not exist — a first run. Every other failure is
   * fail-closed, so a caller can never adopt a silently-empty baseline and clobber the real
   * config on its next save.
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
   * The one public write, used by setup. Round-trips the serialized form through the exact
   * pipeline `load()` runs, so this can never write a file `load()` would later reject — a
   * schema-only check here once let a `@x`-style ref through that the domain mapping refused.
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
