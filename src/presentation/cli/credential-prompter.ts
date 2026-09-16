/**
 * Interactive acquisition of the operator's Telegram app credentials for setup. Setup is
 * interactive by contract, so it prompts for them — api_hash with terminal echo suppressed —
 * rather than requiring them from the environment, where they would land in shell history.
 */
import { isOk, ok, err, type Result } from '../../shared/index.js';

// Where to obtain Telegram app credentials (also used by the CLI usage text).
export const CREDENTIALS_URL = 'https://my.telegram.org/apps';

// Bounded re-prompt attempts before giving up (mirrors the PIN-entry cap).
const MAX_ATTEMPTS = 3;

// Sealed into the encrypted session at setup; never re-read from the environment downstream.
export interface ApiCredentials {
  readonly apiId: number;
  readonly apiHash: string;
}

// A present-and-valid pre-fill is used without prompting; anything absent or invalid falls
// through to an interactive, validating prompt.
export interface ApiCredentialsPrefill {
  readonly apiId?: number | undefined;
  readonly apiHash?: string | undefined;
}

// A diagnostic line printer, a plain prompt and an echo-off secret prompt. The CLI console
// satisfies this structurally; tests supply a fake.
export interface CredentialPromptConsole {
  print(message?: string): void;
  /**
   * `help` lines render on the prompt screen and stay visible while the operator types —
   * guidance on a separate acknowledged screen would have vanished by the time the field
   * appears.
   */
  ask(question: string, help?: readonly string[]): Promise<string>;
  askSecret(question: string, help?: readonly string[]): Promise<string>;
}

// Shared, pure validators — reused for both the env pre-fill check and the interactive
// re-prompt loop.
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

// 32 hexadecimal characters, case-insensitive: surrounding whitespace is trimmed, the value is
// lower-cased, and empty input is rejected.
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

export class InteractiveCredentialPrompter {
  public constructor(private readonly con: CredentialPromptConsole) {}

  public async acquire(
    prefill: ApiCredentialsPrefill,
  ): Promise<ApiCredentials | undefined> {
    // The guidance rides on both prompt screens, visible while typing; its last line names
    // which of the two values this screen wants.
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

  // Uses a present-and-valid pre-fill as-is, otherwise prompts — echo-off for secrets — and
  // re-validates up to `MAX_ATTEMPTS`. Returns `undefined` when the attempts are exhausted.
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
