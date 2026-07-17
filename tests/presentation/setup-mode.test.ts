/**
 * setup — first-run posture (PIN) UX and the mode-aware, SECRET-FREE
 * client-config printer.
 *
 * `runSetup` is the composition entrypoint: it drives ONE persistent Ink app
 * (`runSetupApp`) against the framework-free `SetupUi` port, and constructs its
 * own draft repository while privileged work crosses the injected daemon
 * operator port. We drive the REAL `runSetup` end-to-end with
 * two stubs:
 *
 *   - `runSetupApp` — replaced by a headless driver that invokes the flow with a
 *     SCRIPTED fake `SetupUi`: `menu` dequeues arrow-nav choices, `text`/
 *     `password` dequeue the operator's typed answers in order, `confirm`
 *     interprets a y/N answer, and `pickAccess` commits every enumerated chat
 *     read-only — so the whole interactive flow is deterministic and never mounts
 *     Ink / touches a real TTY; `note` is routed to STDERR (the diagnostic side).
 *   - the directly imported infrastructure adapters — a draft fake plus
 *     deterministic endpoint-key helpers, and a fake operator port that records
 *     login posture and policy application.
 *
 * Security invariants asserted concretely (per the credential-at-rest spec):
 *   1. FIRST-RUN DEFAULT IS NON-PIN: declining the PIN prompt (the default N)
 *      seals the session under a MACHINE slot (SMOOTH), observed at the daemon
 *      operator boundary, and never demands a secret.
 *   2. printClientConfig is MODE-AWARE + SECRET-FREE: a SMOOTH endpoint emits NO
 *      session secret; a HARDENED endpoint emits NO PIN and NO passphrase-file env
 *      (unlock is interactive via the CLI daemon); api_id/api_hash are SEALED into
 *      the session and NEVER inlined into the printed config.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionKeySource } from '../../src/application/index.js';
import { runSetup, type SetupOptions } from '../../src/presentation/cli/setup.js';
import type { OperatorClientPort } from '../../src/presentation/operator/client.js';
import type {
  AccessPickerRequest,
  AccessPickerResult,
} from '../../src/presentation/cli/ink/run-access-picker.js';
import type {
  MenuRequest,
  MenuResult,
} from '../../src/presentation/cli/ink/ui-port.js';
import type {
  ConfirmPromptRequest,
  NoticeRequest,
  PasswordPromptRequest,
  PromptResult,
  SetupUi,
  TextPromptRequest,
} from '../../src/presentation/cli/ink/setup-ui-port.js';
import type {
  AccessBits,
  ChatKey,
} from '../../src/presentation/cli/picker/index.js';

// ---------------------------------------------------------------------------
// Hoisted test doubles + observable state. `vi.hoisted` runs before the
// `vi.mock` factories below, which reference the fakes it returns.
// ---------------------------------------------------------------------------

const H = vi.hoisted(() => {
  interface Ok<T> {
    readonly ok: true;
    readonly value: T;
  }
  const okv = <T>(value: T): Ok<T> => ({ ok: true, value });

  interface KeySourceLike {
    readonly kind: string;
    readonly passphrase?: string;
    readonly keyfilePath?: string;
  }
  interface MaterialLike {
    readonly sessionRef: unknown;
    readonly secret: string;
    readonly apiId: number;
    readonly apiHash: string;
  }
  interface SaveRecord {
    readonly keySource: KeySourceLike;
    readonly material: MaterialLike;
  }
  const state: {
    answers: readonly string[];
    cursor: number;
    menuChoices: readonly string[];
    menuCursor: number;
    existing: boolean;
    sealFails: boolean;
    writeAccess: boolean;
    saves: SaveRecord[];
    events: string[];
  } = {
    answers: [],
    cursor: 0,
    menuChoices: [],
    menuCursor: 0,
    existing: false,
    sealFails: false,
    writeAccess: false,
    saves: [],
    events: [],
  };

  const nextAnswer = (): string => {
    if (state.cursor >= state.answers.length) {
      throw new Error(
        `setup asked more questions than were scripted (at index ${String(
          state.cursor,
        )})`,
      );
    }
    const answer = state.answers[state.cursor] ?? '';
    state.cursor += 1;
    return answer;
  };

  // The arrow-nav menu seam (main menu / login method / session-security). Each
  // scripted choice is the option VALUE the operator would land Enter on, or the
  // sentinel '__cancel__' for an Esc/q cancel.
  const CANCEL = '__cancel__';
  const nextMenuChoice = (): string => {
    if (state.menuCursor >= state.menuChoices.length) {
      throw new Error(
        `setup opened more menus than were scripted (at index ${String(
          state.menuCursor,
        )})`,
      );
    }
    const choice = state.menuChoices[state.menuCursor] ?? CANCEL;
    state.menuCursor += 1;
    state.events.push(`menu:${choice}`);
    return choice;
  };

  // Interpret a scripted y/N answer like the UI confirm screen: an
  // empty answer takes the prompt's default; 'y'/'yes' is true, anything else no.
  const interpretConfirm = (raw: string, fallback: boolean): boolean => {
    const lc = raw.trim().toLowerCase();
    if (lc.length === 0) {
      return fallback;
    }
    return lc === 'y' || lc === 'yes';
  };

  // --- fake SetupUi (the ONE stdin seam the single Ink app exposes) ---
  // `text`/`password` dequeue typed answers; `confirm` interprets a y/N answer;
  // `menu` dequeues an arrow-nav choice; `pickAccess` commits every enumerated
  // chat as a read-only member (mirroring an operator who accepts the defaults);
  // `notify` is the ephemeral-status channel (routed to STDERR); `notice`
  // acknowledges must-read blocks immediately; `status` just runs the async task.
  // No Ink is mounted and no real terminal is touched.
  const makeSetupUi = (): SetupUi => ({
    menu: <T,>(_request: MenuRequest<T>): Promise<MenuResult<T>> => {
      const choice = nextMenuChoice();
      return Promise.resolve(
        choice === CANCEL
          ? { kind: 'cancelled' }
          : { kind: 'selected', value: choice as T },
      );
    },
    // Prompt screens mirror what the operator SEES to STDERR (title + on-screen
    // help), exactly like `notice` below, so assertions on shown guidance hold.
    text: (request: TextPromptRequest): Promise<PromptResult<string>> => {
      process.stderr.write(
        `${[request.title, ...(request.help ?? [])].join('\n')}\n`,
      );
      return Promise.resolve({ kind: 'submitted', value: nextAnswer() });
    },
    password: (request: PasswordPromptRequest): Promise<PromptResult<string>> => {
      process.stderr.write(
        `${[request.title, ...(request.help ?? [])].join('\n')}\n`,
      );
      return Promise.resolve({ kind: 'submitted', value: nextAnswer() });
    },
    confirm: (request: ConfirmPromptRequest): Promise<PromptResult<boolean>> =>
      Promise.resolve({
        kind: 'submitted',
        value: interpretConfirm(nextAnswer(), request.defaultValue),
      }),
    pickAccess: (request: AccessPickerRequest): Promise<AccessPickerResult> => {
      const selection = new Map<ChatKey, AccessBits>();
      for (const row of request.initialState.rows) {
        if (row.kind === 'chat') {
          selection.set(row.chatKey, {
            read: true,
            write: state.writeAccess,
          });
        }
      }
      state.events.push(
        state.writeAccess ? 'access-commit:write' : 'access-commit:read',
      );
      return Promise.resolve({ committed: true, model: { selection } });
    },
    notify: (line: string): void => {
      process.stderr.write(`${line}\n`);
    },
    // A must-read block: acknowledged immediately here, but its content is written
    // to STDERR (the diagnostic side) so integration assertions on the shown text
    // hold regardless of which lane now carries it.
    notice: (request: NoticeRequest): Promise<void> => {
      if (request.title.startsWith('API key for "')) {
        state.events.push('api-key-notice');
      }
      process.stderr.write(`${[request.title, ...request.body].join('\n')}\n`);
      return Promise.resolve();
    },
    showQr: (): void => undefined,
    status: <T,>(_label: string, task: () => Promise<T>): Promise<T> => task(),
  });

  class FakeFileConfigRepository {
    /** No config on disk yet — every suite here edits from a first-run baseline. */
    public loadValidated(): Promise<Ok<undefined>> {
      return Promise.resolve(okv(undefined));
    }
    public save(_config: unknown): Promise<Ok<string>> {
      state.events.push('draft-save');
      return Promise.resolve(okv('{"version":1}\n'));
    }
  }

  return {
    state,
    makeSetupUi,
    nextMenuChoice,
    CANCEL,
    FakeFileConfigRepository,
  };
});

// The WHOLE interactive surface is the ONE persistent Ink app, lazy-imported
// behind `runSetupApp(flow)`. Here we stub that seam to a headless driver that
// invokes the flow with the scripted fake `SetupUi` — so every menu/text/secret/
// confirm/picker is deterministic without ever mounting Ink / touching a TTY.
vi.mock('../../src/presentation/cli/ink/run-setup-app.js', () => ({
  runSetupApp: (flow: (ui: SetupUi) => Promise<void>): Promise<void> =>
    flow(H.makeSetupUi()),
}));

vi.mock('../../src/infrastructure/config/file-config-repository.js', () => ({
  FileConfigRepository: H.FakeFileConfigRepository,
}));

vi.mock('../../src/infrastructure/endpoint-token.js', () => ({
  // Deterministic API-key mint/hash (the real ones are random/crypto). The hash
  // must be a valid sha-256 HEX string or the config schema rejects the draft.
  mintEndpointToken: (): string => 'tgmcp_test-token',
  hashEndpointToken: (): string => `${'a'.repeat(32)}$${'0123456789abcdef'.repeat(4)}`,
  // The env-var-name SSOT the key notices + exit block interpolate.
  ENDPOINT_TOKEN_ENV: 'TELEGRAM_MCP_ENDPOINT_TOKEN',
}));

vi.mock('../../src/infrastructure/app-home.js', () => ({
  // Central-home defaults (real impl reads ~/.telegram-mcp; tests use tmp paths,
  // so these only matter for the "is it the default?" comparison in the block).
  defaultConfigPath: (): string => '/nonexistent-default/config.json',
  defaultSessionDir: (): string => '/nonexistent-default/sessions',
}));

vi.mock('../../src/infrastructure/bounded-read.js', () => ({
  readUtf8Bounded: (): Promise<string> => Promise.resolve('{"version":1}'),
}));

// ---------------------------------------------------------------------------
// Constants pinned to the spec/implementation contract.
// ---------------------------------------------------------------------------

const PIN = 'correct-horse-battery-staple';
// A valid 32-hex api_hash: setup now validates the env pre-fill and uses it
// without prompting, so the scripted answer order below is unchanged.
const API_HASH = 'deadbeefdeadbeefdeadbeefdeadbeef';
const API_ID = 7654321;

// ---------------------------------------------------------------------------
// STDIO capture — suppress + record. setup writes prompts/diagnostics to STDERR
// and ONLY the copy-paste client-config JSON to STDOUT.
// ---------------------------------------------------------------------------

const stdoutChunks: string[] = [];
const stderrChunks: string[] = [];

const ORIGINAL_STDIN_TTY = process.stdin.isTTY;
const ORIGINAL_STDERR_TTY = process.stderr.isTTY;
const ORIGINAL_EXIT_CODE = process.exitCode;

const stdoutText = (): string => stdoutChunks.join('');
const stderrText = (): string => stderrChunks.join('');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeOperator = (): OperatorClientPort => {
  let pending: { readonly apiId: number; readonly apiHash: string } | undefined;
  return {
    connect: () => Promise.resolve({ ok: true, value: undefined }),
    status: () =>
      Promise.resolve({
        ok: true,
        value: {
          posture: H.state.existing ? 'smooth' : 'none',
          locked: false,
          hasAccounts: H.state.existing,
        },
      }),
    listAccounts: () =>
      Promise.resolve({
        ok: true,
        value: {
          accounts: H.state.existing
            ? [{ sessionRef: 'main', label: 'Test User' }]
            : [],
        },
      }),
    authenticate: () => Promise.resolve({ ok: true, value: undefined }),
    login: (input): ReturnType<OperatorClientPort['login']> => {
      pending = { apiId: input.apiId, apiHash: input.apiHash };
      return Promise.resolve({
        ok: true,
        value: {
          flowId: 'flow-1',
          account: { id: '42', displayName: 'Test User' },
        },
      });
    },
    commitLogin: ({ sessionRef, source }): ReturnType<OperatorClientPort['commitLogin']> => {
      if (pending === undefined) {
        return Promise.resolve({ ok: false, error: 'login is not pending' });
      }
      H.state.saves.push({
        keySource: source,
        material: {
          sessionRef,
          secret: 'EXPORTED_SESSION_SECRET',
          apiId: pending.apiId,
          apiHash: pending.apiHash,
        },
      });
      return Promise.resolve({ ok: true, value: { sessionRef } });
    },
    cancelLogin: () => Promise.resolve({ ok: true, value: { accepted: true } }),
    snapshotAccount: () =>
      Promise.resolve({
        ok: true,
        value: {
          chats: [{ id: '-100123', title: 'Team', kind: 'group' }],
          folders: [],
        },
      }),
    applyPolicy: (): ReturnType<OperatorClientPort['applyPolicy']> => {
      H.state.events.push('policy-apply');
      return H.state.sealFails
        ? Promise.resolve({ ok: false, error: 'policy write failed' })
        : Promise.resolve({ ok: true, value: { digest: 'a'.repeat(64) } });
    },
    removeAccount: () => Promise.resolve({ ok: true, value: { changed: true } }),
    setPin: () => Promise.resolve({ ok: true, value: { changed: true } }),
    changePin: () => Promise.resolve({ ok: true, value: { changed: true } }),
    removePin: () => Promise.resolve({ ok: true, value: { changed: true } }),
    exportRecovery: (_current, _outputPath) =>
      Promise.resolve({ ok: true, value: { changed: true as const } }),
    close: () => undefined,
  };
};

const makeOptions = (): SetupOptions => ({
  configPath: join(tmpdir(), `tg-mcp-setup-${randomUUID()}`, 'config.json'),
  sessionDir: join(tmpdir(), `tg-mcp-setup-${randomUUID()}`),
  apiId: API_ID,
  apiHash: API_HASH,
  // The load/admin store's source; irrelevant to the first-run minted posture.
  sessionKey: { kind: 'machine' } satisfies SessionKeySource,
  operatorClient: makeOperator(),
});

/** Options with NO api-cred pre-fill — setup must PROMPT for them. */
const makeOptionsNoCreds = (): SetupOptions => ({
  configPath: join(tmpdir(), `tg-mcp-setup-${randomUUID()}`, 'config.json'),
  sessionDir: join(tmpdir(), `tg-mcp-setup-${randomUUID()}`),
  sessionKey: { kind: 'machine' } satisfies SessionKeySource,
  operatorClient: makeOperator(),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** Safely pluck a server's `env` map out of the printed client-config JSON. */
const envOf = (raw: string, server: string): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error('client config is not an object');
  }
  const servers = parsed['mcpServers'];
  if (!isRecord(servers)) {
    throw new Error('client config has no mcpServers');
  }
  const entry = servers[server];
  if (!isRecord(entry)) {
    throw new Error(`client config has no server '${server}'`);
  }
  const env = entry['env'];
  if (!isRecord(env)) {
    throw new Error(`server '${server}' has no env`);
  }
  return env;
};

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  stdoutChunks.length = 0;
  stderrChunks.length = 0;
  // Pin the machine surface: the exit bundle is emitted only when STDOUT is piped.
  process.stdout.isTTY = false;
  // Suppress + record both streams. setup writes the copy-paste client-config
  // JSON to STDOUT and all prompts/diagnostics to STDERR.
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
    if (typeof chunk === 'string') {
      stdoutChunks.push(chunk);
    }
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown): boolean => {
    if (typeof chunk === 'string') {
      stderrChunks.push(chunk);
    }
    return true;
  });
  // setup REQUIRES an interactive TTY (it refuses to read secrets from a pipe).
  process.stdin.isTTY = true;
  process.stderr.isTTY = true;
  process.exitCode = undefined;

  H.state.answers = [];
  H.state.cursor = 0;
  H.state.menuChoices = [];
  H.state.menuCursor = 0;
  H.state.existing = false;
  H.state.sealFails = false;
  H.state.writeAccess = false;
  H.state.saves = [];
  H.state.events = [];
});

afterEach(() => {
  vi.restoreAllMocks();
  process.stdin.isTTY = ORIGINAL_STDIN_TTY;
  process.stderr.isTTY = ORIGINAL_STDERR_TTY;
  process.exitCode = ORIGINAL_EXIT_CODE;
});

// Scripted text/password/confirm answers consumed by the fake SetupUi. Choice
// menus are scripted separately in `MENU` below. Each comment is the prompt.
const ANSWERS = {
  /** Decline the PIN (default N) -> SMOOTH; create one read endpoint. */
  smoothFirstRun: [
    '', // session name -> 'main'
    '', // "Set a PIN for extra security?" -> default N (non-PIN)
    // (endpoint editor add/save are arrow-nav menu choices, in MENU below)
    '', // endpoint name -> 'reader'
    // (the Ink picker handles chat + r/w selection)
    '', // confirm writes? -> default yes
  ],
  /** Accept a PIN -> HARDENED; create one read endpoint. */
  hardenedFirstRun: [
    '', // session name -> 'main'
    'y', // "Set a PIN for extra security?" -> yes
    PIN, // choose PIN
    PIN, // confirm PIN
    '', // endpoint name -> 'reader'
    '', // confirm writes? -> default yes
  ],
  /**
   * No api-cred pre-fill: setup PROMPTS for api_id then api_hash (right after
   * choosing login), then proceeds through the SMOOTH first-run flow.
   */
  promptedCredsSmooth: [
    String(API_ID), // api_id prompt
    API_HASH, // api_hash prompt (echo-off)
    '', // session name -> 'main'
    '', // "Set a PIN for extra security?" -> default N
    // (endpoint editor add/save are arrow-nav menu choices, in MENU below)
    '', // endpoint name -> 'reader'
    // (the Ink picker handles chat + r/w selection)
    '', // confirm writes? -> default yes
  ],
} as const;

// Scripted arrow-nav menu choices (the option VALUE the operator selects), in the
// order the menus open: main menu -> [login method] -> [endpoint editor] -> ... ->
// main menu (quit). The endpoint list has no Save row: picker/spoke commits persist
// immediately, so leaving the list is a cancel ('__cancel__' = Esc/←).
const MENU = {
  /** login & configure (QR); add one endpoint, then leave the hub; then quit. */
  smoothFirstRun: ['login', 'qr', 'add', '__cancel__', 'quit'],
  hardenedFirstRun: ['login', 'qr', 'add', '__cancel__', 'quit'],
  promptedCredsSmooth: ['login', 'qr', 'add', '__cancel__', 'quit'],
} as const;

// ---------------------------------------------------------------------------
// 1) First-run default is non-PIN (SMOOTH).
// ---------------------------------------------------------------------------

describe('setup first-run posture', () => {
  it('saves and applies the endpoint before returning to the endpoint list', async () => {
    H.state.answers = ANSWERS.smoothFirstRun;
    H.state.menuChoices = MENU.smoothFirstRun;

    await runSetup(makeOptions());

    const accessCommittedAt = H.state.events.indexOf('access-commit:read');
    const savedAt = H.state.events.indexOf('draft-save');
    const appliedAt = H.state.events.indexOf('policy-apply');
    const apiKeyShownAt = H.state.events.indexOf('api-key-notice');
    const endpointListExitAt = H.state.events.indexOf('menu:__cancel__');
    expect(savedAt).toBeGreaterThan(accessCommittedAt);
    expect(appliedAt).toBeGreaterThan(savedAt);
    expect(apiKeyShownAt).toBeGreaterThan(appliedAt);
    expect(endpointListExitAt).toBeGreaterThan(appliedAt);
    expect(H.state.events.filter((event) => event === 'policy-apply')).toHaveLength(1);
  });

  it('saves and applies reviewed writable access before returning to the endpoint list', async () => {
    H.state.answers = ANSWERS.smoothFirstRun;
    H.state.menuChoices = MENU.smoothFirstRun;
    H.state.writeAccess = true;

    await runSetup(makeOptions());

    const accessCommittedAt = H.state.events.indexOf('access-commit:write');
    const savedAt = H.state.events.indexOf('draft-save');
    const appliedAt = H.state.events.indexOf('policy-apply');
    const apiKeyShownAt = H.state.events.indexOf('api-key-notice');
    const endpointListExitAt = H.state.events.indexOf('menu:__cancel__');
    expect(savedAt).toBeGreaterThan(accessCommittedAt);
    expect(appliedAt).toBeGreaterThan(savedAt);
    expect(apiKeyShownAt).toBeGreaterThan(appliedAt);
    expect(endpointListExitAt).toBeGreaterThan(appliedAt);
    expect(H.state.events.filter((event) => event === 'policy-apply')).toHaveLength(1);
  });

  it('defaults to a non-PIN (SMOOTH, machine-bound) session when the operator just presses enter', async () => {
    H.state.answers = ANSWERS.smoothFirstRun;
    H.state.menuChoices = MENU.smoothFirstRun;
    const options = makeOptions();

    await runSetup(options);

    // Exactly one blob was minted, and it was sealed under a MACHINE slot — the
    // SMOOTH posture — without ever collecting a secret.
    expect(H.state.saves).toHaveLength(1);
    const [sealed] = H.state.saves;
    expect(sealed?.keySource.kind).toBe('machine');
    expect(sealed?.keySource.passphrase).toBeUndefined();

    // The api creds are SEALED into the blob (not asked for, not inlined later).
    expect(sealed?.material.apiId).toBe(API_ID);
    expect(sealed?.material.apiHash).toBe(API_HASH);

    // Honest no-PIN summary was shown; the run succeeded.
    expect(stderrText()).toContain('No PIN — day-to-day');
    expect(process.exitCode).toBe(0);
  });

  it('accepting the PIN seals a HARDENED session (passphrase slot)', async () => {
    H.state.answers = ANSWERS.hardenedFirstRun;
    H.state.menuChoices = MENU.hardenedFirstRun;
    const options = makeOptions();

    await runSetup(options);

    expect(H.state.saves).toHaveLength(1);
    const [sealed] = H.state.saves;
    expect(sealed?.keySource.kind).toBe('passphrase');
    expect(sealed?.keySource.passphrase).toBe(PIN);
    expect(process.exitCode).toBe(0);
  });

  it('does not report success or print client config when policy apply fails', async () => {
    H.state.answers = ANSWERS.smoothFirstRun;
    H.state.menuChoices = MENU.smoothFirstRun;
    H.state.sealFails = true;

    await runSetup(makeOptions());

    expect(process.exitCode).toBe(1);
    expect(stdoutText()).toBe('');
    expect(H.state.events.filter((event) => event === 'draft-save')).toHaveLength(1);
    expect(H.state.events.filter((event) => event === 'policy-apply')).toHaveLength(1);
    expect(stderrText()).toContain(
      'Config live apply was not confirmed: policy write failed',
    );
    expect(stderrText()).toContain(
      'Config was saved, but live apply was not confirmed',
    );
    expect(stderrText()).not.toContain('Setup complete.');
  });
});

// ---------------------------------------------------------------------------
// 3) printClientConfig is mode-aware and secret-free.
// ---------------------------------------------------------------------------

describe('setup printClientConfig (mode-aware, secret-free)', () => {
  it('SMOOTH endpoint emits NO session secret and never inlines api creds', async () => {
    H.state.answers = ANSWERS.smoothFirstRun;
    H.state.menuChoices = MENU.smoothFirstRun;
    const options = makeOptions();

    await runSetup(options);

    const out = stdoutText();
    expect(out.length).toBeGreaterThan(0);

    const env = envOf(out, 'telegram-reader');
    // No PIN file reference at all for a machine-bound session.
    expect(env['TELEGRAM_MCP_SESSION_PASSPHRASE_FILE']).toBeUndefined();
    // TOKEN-ONLY wiring: the API key selects + authorizes the endpoint (no
    // name var); paths appear ONLY because these tests override the home.
    expect(env['TELEGRAM_MCP_ENDPOINT']).toBeUndefined();
    expect(env['TELEGRAM_MCP_ENDPOINT_TOKEN']).toBe('tgmcp_test-token');
    expect(env['TELEGRAM_MCP_CONFIG']).toBe(options.configPath);
    expect(env['TELEGRAM_MCP_SESSION_DIR']).toBe(options.sessionDir);

    // api_id/api_hash are SEALED into the session — never printed into the config.
    expect(env['TELEGRAM_API_ID']).toBeUndefined();
    expect(env['TELEGRAM_API_HASH']).toBeUndefined();
    expect(out).not.toContain(API_HASH);
    expect(out).not.toContain(String(API_ID));
  });

  it('HARDENED endpoint carries NO PIN, NO passphrase-file env, NO api creds — unlock is the CLI daemon', async () => {
    H.state.answers = ANSWERS.hardenedFirstRun;
    H.state.menuChoices = MENU.hardenedFirstRun;
    const options = makeOptions();

    await runSetup(options);

    const out = stdoutText();
    const env = envOf(out, 'telegram-reader');

    // NO passphrase-file env by default: the PIN is entered interactively via the
    // daemon, never put in a file or config (the old placeholder leak is gone).
    expect(env['TELEGRAM_MCP_SESSION_PASSPHRASE_FILE']).toBeUndefined();
    expect(out).not.toContain('/path/to/telegram-mcp.pin');

    // The PIN itself appears NOWHERE in the printed config...
    expect(out).not.toContain(PIN);
    // ...and is never echoed to the diagnostics stream either.
    expect(stderrText()).not.toContain(PIN);

    // api creds remain sealed, not inlined.
    expect(env['TELEGRAM_API_ID']).toBeUndefined();
    expect(env['TELEGRAM_API_HASH']).toBeUndefined();
    expect(out).not.toContain(API_HASH);

    // The operator IS told (on STDERR) to unlock via the CLI daemon — no PIN file.
    const err = stderrText();
    expect(err).toContain('npx secure-telegram-mcp start');
    expect(err).not.toContain('umask 077');
  });
});

// ---------------------------------------------------------------------------
// 4) Interactive api-credential acquisition (the export/shell-history fix).
// ---------------------------------------------------------------------------

describe('setup interactive api-credential acquisition', () => {
  it('PROMPTS for api_id/api_hash when none are pre-filled, then seals them', async () => {
    H.state.answers = ANSWERS.promptedCredsSmooth;
    H.state.menuChoices = MENU.promptedCredsSmooth;
    const options = makeOptionsNoCreds();

    await runSetup(options);

    // The prompted creds are sealed into the blob (the SSOT) — never re-read
    // from the environment, never inlined into the printed client config.
    expect(H.state.saves).toHaveLength(1);
    const [sealed] = H.state.saves;
    expect(sealed?.material.apiId).toBe(API_ID);
    expect(sealed?.material.apiHash).toBe(API_HASH);

    // The operator was pointed at where to obtain them.
    expect(stderrText()).toContain('my.telegram.org');

    // The api_hash never appears on STDOUT (the client-config block).
    expect(stdoutText()).not.toContain(API_HASH);
    expect(process.exitCode).toBe(0);
  });

});
