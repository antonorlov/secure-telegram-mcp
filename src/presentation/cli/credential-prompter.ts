/**
 * CredentialPrompter — interactive acquisition of the operator's Telegram app credentials
 * (api_id/api_hash) for the setup flow.
 *
 * Setup is interactive by contract, so it acquires these credentials at the prompt
 * (api_hash with terminal echo suppressed) rather than requiring `export
 * TELEGRAM_API_HASH=...`, which would write the secret into shell history in plaintext. The
 * env value (if any) is an optional pre-fill: present-and-valid is used as-is, otherwise we
 * prompt. The api creds sealed into the encrypted session remain the source of truth; this
 * is acquisition-only.
 *
 * Validation (fail-closed): api_id must be a positive integer; api_hash must be 32
 * hexadecimal characters (whitespace trimmed, case normalised). Empty/whitespace-only input
 * is rejected with a re-prompt.
 */
import { isOk, ok, err, type Result } from '../../shared/index.js';

/** Where to obtain Telegram app credentials (also used by the CLI usage text). */
export const CREDENTIALS_URL = 'https://my.telegram.org/apps';

/** Bounded re-prompt attempts before giving up (mirrors the PIN-entry cap). */
const MAX_ATTEMPTS = 3;

/**
 * The gathered Telegram app credentials, as a typed input DTO. These are sealed into the
 * encrypted session at setup; they are never re-read from the environment downstream.
 */
export interface ApiCredentials {
  readonly apiId: number;
  readonly apiHash: string;
}

/**
 * Optional pre-fill sourced out-of-band (e.g. a 0600 `--env-file` for CI). A
 * present-and-valid value is used without prompting; anything absent or invalid
 * falls through to an interactive, validating prompt.
 */
export interface ApiCredentialsPrefill {
  readonly apiId?: number | undefined;
  readonly apiHash?: string | undefined;
}

/**
 * The narrow console capabilities the prompter needs: a diagnostic line printer, a plain
 * prompt, and an echo-off secret prompt. The CLI `Console` satisfies this structurally;
 * tests supply a fake.
 */
export interface CredentialPromptConsole {
  /**
   * A transient one-line status/diagnostic (a validation error, an "ignoring env value"
   * notice, an abort line). Single-line only.
   */
  print(message?: string): void;
  /**
   * Prompt for one value. `help` lines are rendered on the prompt screen and stay visible
   * while the operator types — guidance on a separate acknowledged screen would have
   * vanished by the time the field appears.
   */
  ask(question: string, help?: readonly string[]): Promise<string>;
  askSecret(question: string, help?: readonly string[]): Promise<string>;
}

// Shared, pure validators — reused for both the env pre-fill check and the interactive
// re-prompt loop.

/** Parse/validate an api_id: a positive integer. */
export const parseApiId = (raw: string): Result<number, string> => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return err('api_id must not be empty.');
  }
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value <= 0) {
    return err('api_id must be a positive integer.');
  }
  return ok(value);
};

/**
 * Parse/validate an api_hash: 32 hexadecimal characters (case-insensitive). Surrounding
 * whitespace is trimmed and the value is lower-cased; empty/whitespace-only input is rejected.
 */
export const parseApiHash = (raw: string): Result<string, string> => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return err('api_hash must not be empty or whitespace.');
  }
  if (!/^[0-9a-f]{32}$/i.test(trimmed)) {
    return err('api_hash must be exactly 32 hexadecimal characters.');
  }
  return ok(trimmed.toLowerCase());
};

// Interactive implementation

export class InteractiveCredentialPrompter {
  public constructor(private readonly con: CredentialPromptConsole) {}

  public async acquire(
    prefill: ApiCredentialsPrefill,
  ): Promise<ApiCredentials | undefined> {
    // The "where to obtain credentials" guidance rides on both prompt screens (visible
    // while typing), never a separate acknowledged screen that has vanished by the time the
    // fields appear. The last line names which of the two values this screen wants.
    const whereFrom = [
      `Create an app at ${CREDENTIALS_URL}`,
      '(log in with your phone number, then open "API development tools").',
    ];
    const apiId = await this.resolve({
      label: 'api_id',
      prompt: 'Telegram api_id',
      help: [
        ...whereFrom,
        'It shows an api_id and an api_hash — enter the api_id (a number) first.',
      ],
      secret: false,
      prefill: prefill.apiId !== undefined ? String(prefill.apiId) : undefined,
      parse: parseApiId,
    });
    if (apiId === undefined) {
      return undefined;
    }
    const apiHash = await this.resolve({
      label: 'api_hash',
      prompt: 'Telegram api_hash',
      help: [
        ...whereFrom,
        'Now the api_hash from the same page (32 characters, entry hidden).',
      ],
      secret: true,
      prefill: prefill.apiHash,
      parse: parseApiHash,
    });
    if (apiHash === undefined) {
      return undefined;
    }
    return { apiId, apiHash };
  }

  /**
   * Resolve one field: use a present-and-valid pre-fill as-is, otherwise prompt
   * (echo-off for secrets) and re-validate up to `MAX_ATTEMPTS` times. Returns
   * `undefined` when the operator exhausts the attempts (the caller aborts).
   */
  private async resolve<T>(params: {
    readonly label: string;
    readonly prompt: string;
    readonly help: readonly string[];
    readonly secret: boolean;
    readonly prefill: string | undefined;
    readonly parse: (raw: string) => Result<T, string>;
  }): Promise<T | undefined> {
    if (params.prefill !== undefined) {
      const pre = params.parse(params.prefill);
      if (isOk(pre)) {
        return pre.value;
      }
      this.con.print(
        `Ignoring ${params.label} from the environment: ${pre.error}`,
      );
    }
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const raw = params.secret
        ? await this.con.askSecret(params.prompt, params.help)
        : await this.con.ask(params.prompt, params.help);
      const result = params.parse(raw);
      if (isOk(result)) {
        return result.value;
      }
      this.con.print(result.error);
    }
    this.con.print(`Too many invalid ${params.label} entries; aborting.`);
    return undefined;
  }
}
