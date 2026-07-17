/**
 * setup — the interactive onboarding entrypoint. A single menu flow: log in
 * (QR or phone-code, with SRP-only 2FA that is never persisted; the session is
 * encrypted at rest), enumerate the account's dialogs + folders by name,
 * create/edit/delete named endpoints (virtual groups), then write the config
 * and print a copy-paste MCP client-config block.
 *
 * ONE INK APP OWNS STDIN: every interaction — menus, text/secret entry, y/N
 * confirms, the access picker + review gate — is a screen of a single persistent
 * Ink app (`runSetupApp`) reached through the framework-free `SetupUi` port. No
 * readline and no second `render()` per prompt: two owners of process.stdin cause
 * the raw-mode-handoff bug. Ink/React load lazily on this TTY path so `connect`
 * never touches them.
 *
 * SECURITY: the login client is unscoped by necessity (the scope boundary does
 * not exist yet) — used to mint a session + read names, then disposed; never
 * handed to a tool or the server. PINs, 2FA passwords, and API hashes are not
 * logged; their prompts are masked, 2FA is discarded after SRP, and the API hash
 * is sealed with the session. A newly minted endpoint key is shown once in the
 * final client-config block. Prompts go to STDERR; only that block uses STDOUT,
 * after the alt-screen is restored so a piped STDOUT stays protocol-clean.
 */
import { resolve } from 'node:path';

import {
  defaultConfigPath,
  defaultSessionDir,
} from '../../infrastructure/app-home.js';
import { readUtf8Bounded } from '../../infrastructure/bounded-read.js';
import { FileConfigRepository } from '../../infrastructure/config/file-config-repository.js';
import { ENDPOINT_TOKEN_ENV } from '../../infrastructure/endpoint-token.js';
import {
  renderTerminalQr,
  writeQrPng,
} from '../../infrastructure/qr/qrcode-qr-renderer.js';
// Developer diagnostics go to this opt-in file only, never a UI frame.
import { debugLog } from '../../infrastructure/setup-debug-log.js';
import type {
  AccountChatDto,
  AccountFolderDto,
  SessionSecurityAdmin,
  SessionKeySource,
} from '../../application/index.js';
import type { OperatorClientPort } from '../operator/client.js';
import type { OperatorAccountDto, OperatorStatusDto } from '../operator/protocol.js';
import { OperatorSessionSecurityAdmin } from '../operator/session-security-admin.js';
import type { ValidatedConfig, ValidatedEndpoint } from '../../config/index.js';
import {
  DEFAULT_CONFIRM_WRITES,
  SessionRef,
  type PermissionVerb,
  type SessionRefValue,
} from '../../domain/index.js';
import { err, isErr, isOk, ok, type Result } from '../../shared/index.js';
import {
  InteractiveCredentialPrompter,
  type ApiCredentials,
  type CredentialPromptConsole,
} from './credential-prompter.js';
import {
  apiKeyNotice,
  endpointDraftFromValidated,
  endpointSummary,
  mintEndpointKey,
  promptEndpointName,
  runAccessEditor,
  uniqueEndpointName,
  type EndpointDraft,
} from './endpoint-draft.js';
import { runEndpointHub } from './endpoint-hub.js';
import { formatNonInteractivePlan } from './non-interactive-plan.js';
// Type-only (erased): these framework-free types never load Ink. The concrete
// `runSetupApp` is lazy-imported on the TTY path below, keeping `connect` free of Ink.
import type { MenuOption } from './ink/ui-port.js';
import type {
  ConfirmPromptRequest,
  PasswordPromptRequest,
  SetupUi,
  TextPromptRequest,
} from './ink/setup-ui-port.js';

export interface SetupOptions {
  readonly configPath: string;
  readonly sessionDir: string;
  /**
   * Optional pre-fill for the operator's Telegram app credentials. Setup acquires
   * these interactively (api_hash masked); a valid env value is used as a default.
   * Never required from the environment — that would leak the secret into shell history.
   */
  readonly apiId?: number;
  readonly apiHash?: string;
  /** Out-of-band key material to encrypt the session at rest. */
  readonly sessionKey: SessionKeySource;
  /** Daemon operator session used by production; injectable for setup tests. */
  readonly operatorClient: OperatorClientPort;
}

// Config draft — a plain editable model over the schema's NORMALISED types, so a
// re-run round-trips the file losslessly (serialization lives in FileConfigRepository).

interface ConfigDraft {
  disabledVerbs: PermissionVerb[];
  /** Global download egress cap (bytes); carried verbatim so a save never drops it. */
  maxDownloadBytes?: number;
  endpoints: EndpointDraft[];
}

/** Endpoint-edit result: the draft always reflects disk; policy state is explicit. */
interface EditedConfig {
  readonly draft: ConfigDraft;
  readonly policyApplied: boolean;
}

/** One explicit endpoint commit. `false` means the draft write itself was rejected. */
type CommitDraft = (draft: ConfigDraft) => Promise<boolean>;

/**
 * The at-rest unlock posture, derived from the slots a blob carries (never a
 * stored flag): SMOOTH = machine-bound (no operator secret); HARDENED = a
 * passphrase/recovery PIN with no machine slot.
 */
type SessionPosture = 'smooth' | 'hardened';

/** A first-run posture choice: the source to seal under + its derived mode. */
interface SealDecision {
  readonly source: SessionKeySource;
  readonly posture: SessionPosture;
}

/** The outcome of a login + endpoint-editing pass, with the session's posture. */
interface LoginResult {
  readonly draft: ConfigDraft;
  readonly sessionRef: string;
  readonly posture: SessionPosture;
  /**
   * The already-verified key source retained for the setup home-menu cache. For a
   * first-run PIN this is the chosen PIN, so returning home does not prompt again.
   */
  readonly unlockSource: SessionKeySource;
}

/**
 * Deferred terminal output — accumulated during the flow and emitted only after
 * the Ink app unmounts (alt-screen restored), so it persists on the normal screen
 * instead of vanishing with the alt buffer. `stdout` is the copy-paste
 * client-config block (protocol surface); `stderr` is the human guidance.
 */
interface DeferredOutput {
  stdout: string;
  stderr: string;
}

// Wizard-shell choice menus — each a plain data model rendered by the reusable
// arrow-nav `MenuScreen` (via `ui.menu`); the shell switches on the returned value.

type LoggedOutChoice = 'login' | 'quit';
type LoggedInChoice = 'configure' | 'accounts' | 'security' | 'quit';

/** The session name/ref used when the operator does not name one. */
const DEFAULT_SESSION_REF = 'main';

// State-aware home menu: detect an existing session and offer login only when logged out.
const LOGGED_OUT_MENU: readonly MenuOption<LoggedOutChoice>[] = [
  { value: 'login', label: 'Log in', hint: 'connect your Telegram account (QR or phone)' },
  { value: 'quit', label: 'Quit', hint: 'exit setup' },
];
const loggedInMenu = (
  accountLabel: string,
): readonly MenuOption<LoggedInChoice>[] => [
  {
    value: 'configure',
    label: 'Configure endpoints',
    hint: 'create or edit your virtual groups',
  },
  {
    value: 'accounts',
    label: 'Accounts',
    hint: `switch or add accounts · log out (${accountLabel})`,
  },
  {
    value: 'security',
    label: 'Session security',
    hint: 'add/change/remove PIN · export recovery keyfile',
  },
  { value: 'quit', label: 'Quit', hint: 'exit setup' },
];

// The LOCKED home menu: a session file exists but no unlock channel is available
// (a HARDENED app with no env PIN). Never claim "Logged in" nor offer the
// session-dependent actions as usable — the only truthful choices are enter the
// PIN, add/replace an account, or quit.
type LockedChoice = 'unlock' | 'login' | 'quit';
const LOCKED_MENU: readonly MenuOption<LockedChoice>[] = [
  { value: 'unlock', label: 'Enter PIN', hint: 'unlock the encrypted session to configure it' },
  { value: 'login', label: 'Log in again', hint: 'connect another Telegram account' },
  { value: 'quit', label: 'Quit', hint: 'exit setup' },
];

type LoginMethod = 'qr' | 'phone';
const LOGIN_METHOD_OPTIONS: readonly MenuOption<LoginMethod>[] = [
  {
    value: 'qr',
    label: 'QR code',
    hint: 'scan with Telegram (Settings -> Devices -> Link Desktop Device)',
  },
  { value: 'phone', label: 'Phone number', hint: 'receive a login code via SMS/Telegram' },
];

type SecurityChoice = 'add' | 'change' | 'remove' | 'export' | 'apply' | 'back';
const SECURITY_MENU_OPTIONS: readonly MenuOption<SecurityChoice>[] = [
  { value: 'add', label: 'Add PIN', hint: 'SMOOTH -> HARDENED (machine binding removed)' },
  { value: 'change', label: 'Change PIN', hint: 're-key a HARDENED session' },
  { value: 'remove', label: 'Remove PIN', hint: 'HARDENED -> SMOOTH (machine-bound)' },
  {
    value: 'export',
    label: 'Export recovery keyfile',
    hint: 'unlock without the PIN (offline backup)',
  },
  {
    value: 'apply',
    label: 'Apply config changes',
    hint: 'validate and apply config.json after a hand edit',
  },
  { value: 'back', label: 'Back', hint: 'return to the main menu' },
];

/** Prefix marking a dynamic "select this endpoint (by index)" menu row. */
const ENDPOINT_ROW_PREFIX = 'endpoint:';

// SetupUi prompt helpers — thin adapters over the discriminated `PromptResult` so
// call sites read like a plain value, with each cancel mapped to the safe default.

/** A free-text prompt; `undefined` when the operator cancels (Esc). */
const promptText = async (
  ui: SetupUi,
  request: TextPromptRequest,
): Promise<string | undefined> => {
  const result = await ui.text(request);
  return result.kind === 'submitted' ? result.value : undefined;
};

/** A masked secret prompt; `undefined` when the operator cancels (Esc). */
const promptSecret = async (
  ui: SetupUi,
  request: PasswordPromptRequest,
): Promise<string | undefined> => {
  const result = await ui.password(request);
  return result.kind === 'submitted' ? result.value : undefined;
};

/** A y/N confirm; a cancel (Esc) resolves to the prompt's own safe default. */
const promptConfirm = async (
  ui: SetupUi,
  request: ConfirmPromptRequest,
): Promise<boolean> => {
  const result = await ui.confirm(request);
  return result.kind === 'submitted' ? result.value : request.defaultValue;
};

/**
 * A defaulted free-text prompt (session/endpoint name): the pre-filled value is
 * accepted on empty submit or on cancel ("just press enter -> default").
 */
const promptDefault = async (
  ui: SetupUi,
  title: string,
  fallback: string,
): Promise<string> => {
  const result = await ui.text({ title, defaultValue: fallback });
  if (result.kind !== 'submitted') {
    return fallback;
  }
  const trimmed = result.value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
};

/**
 * The narrow `CredentialPromptConsole` the credential prompter needs, backed by
 * the Ink app: `print` shows an ephemeral one-liner; `ask`/`askSecret` route to
 * the text/masked fields with acquisition guidance rendered on the prompt screen.
 * The prompter keeps its own validate + re-prompt loop, so a cancel surfaces as an
 * empty string it rejects and re-prompts.
 */
const credentialConsole = (ui: SetupUi): CredentialPromptConsole => ({
  print: (message = ''): void => {
    ui.notify(message);
  },
  ask: async (
    question: string,
    help?: readonly string[],
  ): Promise<string> => {
    return (
      (await promptText(ui, {
        title: question,
        ...(help !== undefined ? { help } : {}),
      })) ?? ''
    );
  },
  askSecret: async (
    question: string,
    help?: readonly string[],
  ): Promise<string> => {
    return (
      (await promptSecret(ui, {
        title: question,
        ...(help !== undefined ? { help } : {}),
      })) ?? ''
    );
  },
});

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/**
 * Load the existing config.json as the editing baseline, through the config
 * repository's `loadValidated` — the exact bounded-read + schema/lint/domain
 * pipeline the daemon loads through (never a weaker gate that would let setup
 * adopt-and-resave a config the runtime then rejects). Only a MISSING file is a
 * first run (empty draft); an unreadable, malformed, or SCHEMA-INVALID one is
 * an ERROR the caller must stop on — editing would start from an empty (or
 * silently gutted) draft and the next autosave would overwrite the operator's
 * real config (endpoints, scopes, token hashes) with just the new edits.
 *
 * Exported for its unit test; not part of the public CLI surface.
 */
const draftRepository = (configPath: string): FileConfigRepository =>
  new FileConfigRepository({
    filePath: configPath,
    warn: (message: string): void => {
      debugLog('[config][warn]', message);
    },
  });

export const loadExistingDraft = async (
  configPath: string,
): Promise<Result<ConfigDraft, string>> => {
  const loaded = await draftRepository(configPath).loadValidated();
  if (isErr(loaded)) {
    return err(
      `the existing config at ${configPath} is invalid or unreadable (${loaded.error.message}) — repair (or remove) it and re-run setup`,
    );
  }
  if (loaded.value === undefined) {
    return ok({ disabledVerbs: [], endpoints: [] }); // first run
  }
  const config = loaded.value;
  return ok({
    disabledVerbs: [...config.killSwitch.disabledVerbs],
    ...(config.maxDownloadBytes !== undefined
      ? { maxDownloadBytes: config.maxDownloadBytes }
      : {}),
    endpoints: config.endpoints.map(endpointDraftFromValidated),
  });
};

/**
 * Assemble the in-memory draft into the repository's `ValidatedConfig` shape.
 * NOT a second on-disk codec — serialization stays inside FileConfigRepository,
 * and `save()` re-validates the serialized form fail-closed (duplicate names,
 * empty scope, zero endpoints), so the nonempty-tuple cast below is enforced at
 * the write gate rather than trusted. Only the salted hash crosses over — the
 * plaintext key (`token`) is draft-only and NEVER part of the persisted shape
 * (it is shown once at mint + inlined into the exit `.mcp.json` block).
 */
const draftToConfig = (draft: ConfigDraft): ValidatedConfig => ({
  version: 1,
  killSwitch: { disabledVerbs: draft.disabledVerbs },
  // Emitted only when present so no-cap files stay byte-stable.
  ...(draft.maxDownloadBytes !== undefined
    ? { maxDownloadBytes: draft.maxDownloadBytes }
    : {}),
  endpoints: draft.endpoints.map(
    (ep): ValidatedEndpoint => ({
      name: ep.name,
      session: ep.session,
      scope: {
        chats: ep.chats,
        folders: ep.folders,
        chatOverrides: ep.chatOverrides,
      },
      verbs: ep.verbs as ValidatedEndpoint['verbs'],
      hitl: { confirmWrites: ep.confirmWrites },
      tokenHash: ep.tokenHash,
    }),
  ) as ValidatedConfig['endpoints'],
});

// QR rendering — terminal QR + tg:// URL, with a PNG only when terminal rendering fails.

const renderQr = async (
  ui: SetupUi,
  url: string,
  expiresInSeconds: number,
  pngPath: string,
): Promise<void> => {
  // The terminal QR is rendered as one full-contrast screen element (via showQr),
  // so it is never truncated by status output nor dimmed unscannable.
  const rendered = renderTerminalQr(url);
  const footer: string[] = [`URL: ${url}`];
  if (rendered === undefined && (await writeQrPng(url, pngPath))) {
    footer.unshift(`PNG fallback: ${pngPath}`);
  }
  ui.showQr({
    title: 'Scan with Telegram: Settings -> Devices -> Link Desktop Device',
    qr: rendered ?? '(terminal QR unavailable; use the URL or PNG fallback)',
    footer,
    // The screen renders a LIVE countdown from this deadline (1s ticks).
    expiresAtMs: Date.now() + expiresInSeconds * 1_000,
  });
};

// Posture (PIN) UX — first-run choice, secret entry, honest summaries.
//
// SECURITY: the seal posture is chosen interactively here, never inherited from
// the model. HARDENED requires a confirmed, NFC-normalised passphrase of at least
// MIN_PIN_LENGTH characters; SMOOTH derives the key from the host machine id, and
// `normaliseId` fails closed on an empty/placeholder id (a cleared golden-image
// machine-id) so a machine blob cannot bind to a non-identifying host.

const MIN_PIN_LENGTH = 8;
const MAX_PIN_ATTEMPTS = 3;

/** True only when BOTH the input and the diagnostic stream are real terminals. */
const isInteractiveTty = (): boolean =>
  process.stdin.isTTY && process.stderr.isTTY;

/**
 * The non-TTY / `--no-input` / CI branch: setup is interactive by contract, so
 * rather than block on stdin it prints the current config plus the equivalent flags
 * and exits non-zero. Secret-safe: the plan reads only the validated config (no
 * session string / token) and never echoes a secret.
 */
const printNonInteractivePlan = async (options: SetupOptions): Promise<void> => {
  const loaded = await draftRepository(options.configPath).loadValidated();
  const config = isOk(loaded) ? loaded.value : undefined;
  process.stderr.write(
    formatNonInteractivePlan({
      configPath: options.configPath,
      sessionDir: options.sessionDir,
      ...(config !== undefined ? { config } : {}),
    }),
  );
};

/** Infer a session's posture from the source used to unlock it (machine = SMOOTH). */
const inferPostureFromSource = (source: SessionKeySource): SessionPosture =>
  source.kind === 'machine' ? 'smooth' : 'hardened';

/** Honest, non-marketing summary of the no-PIN (machine-bound) choice. */
const printSmoothSummary = (ui: SetupUi): Promise<void> =>
  ui.notice({
    title: 'No PIN — day-to-day',
    body: [
      "Your session and access config are encrypted with a key tied to THIS machine's identity.",
      'Nothing to unlock: Telegram MCP and its clients work immediately, every boot.',
      'A copy of the files is useless elsewhere — but this does NOT protect against',
      'someone who can run code as your user on THIS machine.',
      'You can add a PIN any time: re-run this setup (Security menu).',
      'Moving to a new machine: export a recovery keyfile first (Security menu), or re-login there.',
    ],
  });

/**
 * The post-creation operations notice: day-to-day how-to only. The commitment
 * itself was consented to on the decision and entry screens.
 */
const printInteractiveUnlockGuidance = (ui: SetupUi): Promise<void> =>
  ui.notice({
    title: 'PIN set — day-to-day',
    body: [
      'To unlock (once per boot, and after the inactivity auto-lock):',
      '  npx secure-telegram-mcp start   # prompts for your PIN; MCP clients connect automatically',
      'To change chat access: re-run setup to apply the config securely under your PIN',
      '(hand-edits to config.json stay inert until applied here).',
      'Moving to a new machine: export a recovery keyfile first (Security menu), or re-login there.',
      '(Headless/CI: point TELEGRAM_MCP_SESSION_PASSPHRASE_FILE at a 0600 PIN file.)',
    ],
  });

/** Prompt + confirm a new PIN/passphrase (NFC-normalised, min-length enforced). */
const acquirePinSource = async (
  ui: SetupUi,
): Promise<SealDecision | undefined> => {
  for (let attempt = 0; attempt < MAX_PIN_ATTEMPTS; attempt += 1) {
    // Min-length is a recoverable, in-place re-prompt (the field stays open);
    // NFC-normalise so the confirm compare below is exact.
    const pin = await promptSecret(ui, {
      title: `Choose a PIN/passphrase (min ${String(MIN_PIN_LENGTH)} chars): `,
      help: ['No recovery if forgotten — pick something you will remember.'],
      transform: (raw) => raw.normalize('NFC'),
      validate: (value) =>
        value.length < MIN_PIN_LENGTH
          ? `Too short — at least ${String(MIN_PIN_LENGTH)} characters.`
          : undefined,
    });
    if (pin === undefined) {
      ui.notify('PIN entry cancelled.');
      return undefined;
    }
    const confirm = await promptSecret(ui, {
      title: 'Confirm PIN/passphrase: ',
      transform: (raw) => raw.normalize('NFC'),
    });
    if (confirm === undefined) {
      ui.notify('PIN entry cancelled.');
      return undefined;
    }
    if (pin !== confirm) {
      ui.notify('Entries did not match; try again.');
      continue;
    }
    return { source: { kind: 'passphrase', passphrase: pin }, posture: 'hardened' };
  }
  ui.notify('Too many attempts; aborting PIN entry.');
  return undefined;
};

/** Read an EXISTING PIN (no confirm/min-length) for an admin re-key operation. */
const askExistingPin = async (ui: SetupUi): Promise<SessionKeySource> => {
  const passphrase = await promptSecret(ui, {
    title: 'Current PIN/passphrase: ',
    transform: (raw) => raw.normalize('NFC'),
  });
  return { kind: 'passphrase', passphrase: passphrase ?? '' };
};

/**
 * Authenticate this setup connection to a hardened daemon. The daemon is the
 * only verifier; setup never opens the encrypted repository itself.
 */
const authenticateHardenedOperator = async (
  ui: SetupUi,
  client: OperatorClientPort,
  configured: SessionKeySource,
): Promise<SessionKeySource | undefined> => {
  if (configured.kind !== 'machine') {
    const authenticated = await client.authenticate(configured);
    return isErr(authenticated) ? undefined : configured;
  }
  for (let attempt = 0; attempt < MAX_PIN_ATTEMPTS; attempt += 1) {
    const source = await askExistingPin(ui);
    // askExistingPin maps a cancel/empty entry to passphrase '': treat it as a
    // truthful abort rather than spending a retry on a guaranteed-wrong secret.
    if (source.kind === 'passphrase' && source.passphrase.length === 0) {
      ui.notify('PIN entry cancelled — the session stays locked.');
      return undefined;
    }
    const authenticated = await client.authenticate(source);
    if (!isErr(authenticated)) {
      return source;
    }
    ui.notify('Wrong PIN.');
  }
  ui.notify('Too many attempts; the session stays locked.');
  return undefined;
};

/**
 * First-run posture choice: "Set a PIN?" (default no). Yes collects a PIN
 * (HARDENED); no selects SMOOTH (machine-bound) after an honest summary. Returns
 * `undefined` when the operator cancels PIN entry.
 */
const choosePosture = async (
  ui: SetupUi,
): Promise<SealDecision | undefined> => {
  const setPin = await promptConfirm(ui, {
    title: 'Set a PIN for extra security?',
    help: [
      'A PIN encrypts your Telegram session and access config on this machine.',
      'With a PIN:  you type it to unlock Telegram MCP after each reboot or auto-lock,',
      '             and to change which chats the MCP server can access.',
      'Without one: everything unlocks automatically, keyed to this machine.',
      'A forgotten PIN cannot be recovered — you would log in and configure again.',
    ],
    defaultValue: false,
  });
  if (setPin) {
    return acquirePinSource(ui);
  }
  await printSmoothSummary(ui);
  return { source: { kind: 'machine' }, posture: 'smooth' };
};

// Session security menu: setup calls a daemon-backed SessionAdmin port. One
// PIN for the whole app (like native Telegram clients): each operation prompts once
// and applies to all sessions on disk, regenerating the DEK and re-encrypting.
// MCP tools never receive this write-side capability.

/** Add the app PIN (SMOOTH -> HARDENED): unlock via the machine slot, seal under the PIN. */
const doAddPin = async (ui: SetupUi, admin: SessionSecurityAdmin): Promise<boolean> => {
  const decision = await acquirePinSource(ui);
  if (decision === undefined) {
    ui.notify('Add PIN cancelled.');
    return false;
  }
  const result = await ui.status('Updating encrypted data with the new PIN…', () =>
    admin.addKek({ current: { kind: 'machine' }, pin: decision.source }),
  );
  if (isErr(result)) {
    ui.notify(`Could not add PIN: ${result.error.message}`);
    return false;
  }
  ui.notify('PIN set — the app is now HARDENED (machine binding removed).');
  await printInteractiveUnlockGuidance(ui);
  return true;
};

/** Change the app PIN (HARDENED -> HARDENED): unlock via the current PIN, re-key. */
const doChangePin = async (ui: SetupUi, admin: SessionSecurityAdmin): Promise<boolean> => {
  const current = await askExistingPin(ui);
  const decision = await acquirePinSource(ui);
  if (decision === undefined) {
    ui.notify('Change PIN cancelled.');
    return false;
  }
  const result = await ui.status('Re-keying the app…', () =>
    admin.rewrapKek({ current, replacement: decision.source }),
  );
  if (isErr(result)) {
    ui.notify(`Could not change PIN: ${result.error.message}`);
    return false;
  }
  ui.notify('PIN changed.');
  await printInteractiveUnlockGuidance(ui);
  return true;
};

/** Remove the app PIN (HARDENED -> SMOOTH): encrypt every blob machine-bound. */
const doRemovePin = async (
  ui: SetupUi,
  admin: SessionSecurityAdmin,
): Promise<boolean> => {
  const current = await askExistingPin(ui);
  const result = await ui.status('Updating encrypted data for this machine…', () =>
    admin.removeKek({ current }),
  );
  if (isErr(result)) {
    ui.notify(`Could not remove PIN: ${result.error.message}`);
    return false;
  }
  ui.notify('PIN removed — the app is now SMOOTH (machine-bound).');
  await printSmoothSummary(ui);
  return true;
};

/** Export a recovery key for blobs present now (stays HARDENED). */
const doExportRecovery = async (ui: SetupUi, admin: SessionSecurityAdmin): Promise<void> => {
  const current = await askExistingPin(ui);
  const outputPath = await promptText(ui, {
    title: 'Path to write the recovery keyfile (created 0600): ',
  });
  if (outputPath === undefined || outputPath.trim().length === 0) {
    ui.notify('Export cancelled (no path given).');
    return;
  }
  const result = await ui.status('Writing recovery keyfile…', () =>
    admin.emitRecoveryKeyfile({ current, outputPath }),
  );
  if (isErr(result)) {
    ui.notify(`Could not export recovery keyfile: ${result.error.message}`);
    return;
  }
  await ui.notice({
    title: 'Recovery keyfile written',
    body: [
      `  ${outputPath} (0600)`,
      '  Store it OFFLINE and OFF this machine: its raw bytes unlock the encrypted data present now WITHOUT the PIN.',
      '  Export a new recovery key after adding/replacing an account or changing the PIN.',
      '  To migrate a host: copy the session dir (policy.blob + *.session) or use ' +
        'TELEGRAM_MCP_SESSION_KEYFILE=<path> to unlock with the keyfile.',
    ],
  });
};

const accountLabel = (account: OperatorAccountDto): string =>
  account.label !== undefined && account.label.length > 0
    ? account.label
    : `session '${account.sessionRef}'`;

/**
 * Top-level PIN lifecycle menu. The sessions on disk are the ground truth, and each
 * operation applies to all of them. All mutations go through the SessionAdmin port;
 * the unlock `current` is gathered interactively (never from the environment), so
 * the menu works regardless of how the daemon was unlocked.
 */
const runSecurityMenu = async (
  ui: SetupUi,
  options: SetupOptions,
  admin: SessionSecurityAdmin,
  accounts: readonly OperatorAccountDto[],
): Promise<boolean> => {
  const client = options.operatorClient;
  const first = accounts[0];
  if (first === undefined) {
    ui.notify('No encrypted session exists yet — log in first.');
    return false;
  }
  const subtitle =
    accounts.length === 1
      ? `Protecting ${accountLabel(first)}`
      : `Protecting all ${String(accounts.length)} accounts (one PIN, like Telegram)`;

  let managing = true;
  let invalidatedUnlock = false;
  while (managing) {
    // Posture-gated options (truthful, not a static list): "Add PIN" only on a
    // SMOOTH app; Change/Remove/Export only on a HARDENED one. Re-read posture each
    // loop so add/remove (which flip it) stay honest. Apply + Back are always valid.
    const status = await client.status();
    if (isErr(status)) {
      ui.notify(`Could not read session security: ${status.error}.`);
      return invalidatedUnlock;
    }
    const posture = status.value.posture;
    const allowed: readonly SecurityChoice[] =
      posture === 'smooth'
        ? ['add', 'apply', 'back']
        : posture === 'hardened'
          ? ['change', 'remove', 'export', 'apply', 'back']
          : ['apply', 'back'];
    const menuOptions = SECURITY_MENU_OPTIONS.filter((o) =>
      allowed.includes(o.value),
    );
    const result = await ui.menu<SecurityChoice>({
      title: 'Session security',
      subtitle,
      options: menuOptions,
    });
    // Esc/q backs out to the main menu (the safe default for this submenu).
    const choice = result.kind === 'selected' ? result.value : 'back';
    switch (choice) {
      case 'add':
        invalidatedUnlock = (await doAddPin(ui, admin)) || invalidatedUnlock;
        break;
      case 'change':
        invalidatedUnlock = (await doChangePin(ui, admin)) || invalidatedUnlock;
        break;
      case 'remove':
        invalidatedUnlock =
          (await doRemovePin(ui, admin)) || invalidatedUnlock;
        break;
      case 'export':
        await doExportRecovery(ui, admin);
        break;
      case 'apply': {
        // Applying rides the app-key unlock: a hardened app needs the current PIN;
        // a smooth app uses the machine binding. Then validate and seal the draft.
        const source: SessionKeySource =
          posture === 'hardened' ? await askExistingPin(ui) : { kind: 'machine' };
        await applyConfigDraft(ui, options, source);
        break;
      }
      case 'back':
        managing = false;
        break;
    }
  }
  return invalidatedUnlock;
};

// ---------------------------------------------------------------------------
// Login phase
// ---------------------------------------------------------------------------

const doLogin = async (
  ui: SetupUi,
  options: SetupOptions,
  creds: ApiCredentials,
  posture: OperatorStatusDto['posture'],
  knownSource?: SessionKeySource,
): Promise<LoginResult | undefined> => {
  const client = options.operatorClient;
  let source = knownSource ?? options.sessionKey;
  if (posture === 'hardened' && source.kind === 'machine') {
    ui.notify('The app is PIN-protected — enter the PIN to add this account.');
    source = await askExistingPin(ui);
  }
  if (!(await authenticateOperator(ui, client, source))) return undefined;
  const listed = await client.listAccounts();
  if (isErr(listed)) {
    ui.notify(`Cannot read saved accounts: ${listed.error}.`);
    return undefined;
  }

  const methodResult = await ui.menu<LoginMethod>({
    title: 'Login method',
    options: LOGIN_METHOD_OPTIONS,
  });
  if (methodResult.kind === 'cancelled') {
    ui.notify('Login cancelled.');
    return undefined;
  }
  const loggedIn = await client.login({
    apiId: creds.apiId,
    apiHash: creds.apiHash,
    method: methodResult.value,
    onQr: (info) =>
      renderQr(
        ui,
        info.url,
        info.expiresInSeconds,
        `${options.configPath}.qr.png`,
      ),
    ask: async (kind) => {
      switch (kind) {
        case 'phone':
          return (
            (await promptText(ui, {
              title: 'Phone number (international, e.g. +15551234567): ',
            })) ?? ''
          );
        case 'code':
          return (
            (await promptText(ui, { title: 'Login code Telegram sent you: ' })) ??
            ''
          );
        case 'password':
          return (
            (await promptSecret(ui, { title: '2FA password (not stored): ' })) ??
            ''
          );
      }
    },
  });
  if (isErr(loggedIn)) {
    ui.notify(`Login failed: ${loggedIn.error}`);
    return undefined;
  }
  const { flowId, account } = loggedIn.value;
  ui.notify(`Logged in as ${account.displayName}.`);

  const usernameRef =
    account.username !== undefined
      ? account.username.toLowerCase().replace(/[^a-z0-9_-]/g, '')
      : '';
  const suggestedRef = isOk(SessionRef.create(usernameRef))
    ? usernameRef
    : DEFAULT_SESSION_REF;
  const sessionRefRaw = await promptDefault(ui, 'Session name', suggestedRef);
  const refResult = SessionRef.create(sessionRefRaw);
  if (isErr(refResult)) {
    await client.cancelLogin(flowId);
    ui.notify(`Invalid session name: ${refResult.error.message}`);
    return undefined;
  }

  const refExists = listed.value.accounts.some(
    (existing) => existing.sessionRef === String(refResult.value),
  );
  if (refExists) {
    const overwrite = await promptConfirm(ui, {
      title: `Session '${String(refResult.value)}' already exists — overwrite it?`,
      subtitle:
        'Replaces that stored login; every endpoint using this name will then ' +
        'run as the account you just logged in. This cannot be undone.',
      defaultValue: false,
    });
    if (!overwrite) {
      await client.cancelLogin(flowId);
      ui.notify('Kept the existing session; this login was NOT persisted.');
      return undefined;
    }
  }

  let decision: SealDecision | undefined;
  if (posture === 'none') {
    decision = await choosePosture(ui);
  } else if (posture === 'smooth') {
    decision = { source: { kind: 'machine' }, posture: 'smooth' };
  } else {
    decision = { source, posture: 'hardened' };
  }
  if (decision === undefined) {
    await client.cancelLogin(flowId);
    ui.notify('No session posture chosen; the login was NOT persisted.');
    return undefined;
  }

  const committed = await ui.status('Encrypting session at rest…', () =>
    client.commitLogin({
      flowId,
      sessionRef: String(refResult.value),
      source: decision.source,
    }),
  );
  if (isErr(committed)) {
    ui.notify(`Could not persist encrypted session: ${committed.error}`);
    return undefined;
  }
  if (decision.posture === 'hardened') {
    const authenticated = await client.authenticate(decision.source);
    if (isErr(authenticated)) {
      ui.notify(`Session saved, but setup could not authorize it: ${authenticated.error}`);
      return undefined;
    }
    await printInteractiveUnlockGuidance(ui);
  }
  ui.notify(`Session '${sessionRefRaw}' encrypted at rest.`);

  const edited = await snapshotAndEdit(ui, options, String(refResult.value));
  if (edited === undefined) return undefined;
  if (!edited.policyApplied) {
    return undefined;
  }
  return {
    draft: edited.draft,
    sessionRef: String(refResult.value),
    posture: decision.posture,
    unlockSource: decision.source,
  };
};

// ---------------------------------------------------------------------------
// Enumerate + edit phase
// ---------------------------------------------------------------------------

const editEnumeratedAccount = async (
  ui: SetupUi,
  options: SetupOptions,
  sessionRef: string,
  chats: readonly AccountChatDto[],
  folders: readonly AccountFolderDto[],
): Promise<EditedConfig | undefined> => {
  ui.notify(
    `Found ${String(chats.length)} dialog(s) and ${String(folders.length)} folder(s).`,
  );

  // config.json is the crash-safe editable draft. Each explicit endpoint save
  // writes it first, then publishes the same validated document to the sealed
  // runtime policy. An unreadable/malformed draft STOPS here — editing from an
  // empty baseline would clobber it on autosave.
  const draftRes = await loadExistingDraft(options.configPath);
  if (isErr(draftRes)) {
    ui.notify(`Cannot edit endpoints: ${draftRes.error}`);
    return undefined;
  }
  const draft = draftRes.value;
  let policyApplied = true;
  const commitDraft: CommitDraft = async (current): Promise<boolean> => {
    const raw = await persistDraft(ui, options, current);
    if (raw === undefined) return false;
    // The operator connection was authenticated before account enumeration.
    // A policy failure cannot undo an already-atomic draft write. A teardown
    // failure can also arrive after publication, so report uncertainty rather
    // than claiming that the saved policy is definitely inactive.
    policyApplied = await applySavedConfig(ui, options.operatorClient, raw);
    if (!policyApplied) {
      ui.notify(
        'Config was saved, but live apply was not confirmed; resolve the error, then restart Telegram MCP or retry Apply config changes.',
      );
    }
    return true;
  };
  await editLoop(ui, draft, chats, folders, sessionRef, commitDraft);
  return { draft, policyApplied };
};

/**
 * Shared snapshot→edit tail: enumerate the account's dialogs and folders
 * (spinner, error notify) and run the endpoint editor over them.
 */
const snapshotAndEdit = async (
  ui: SetupUi,
  options: SetupOptions,
  ref: string,
): Promise<EditedConfig | undefined> => {
  const snapshot = await ui.status('Reading your dialogs and folders…', () =>
    options.operatorClient.snapshotAccount(ref),
  );
  if (isErr(snapshot)) {
    ui.notify(`Could not read the account: ${snapshot.error}`);
    return undefined;
  }
  return editEnumeratedAccount(
    ui,
    options,
    ref,
    snapshot.value.chats,
    snapshot.value.folders,
  );
};

const editLoop = async (
  ui: SetupUi,
  draft: ConfigDraft,
  chats: readonly AccountChatDto[],
  folders: readonly AccountFolderDto[],
  sessionRef: string,
  commitDraft: CommitDraft,
): Promise<void> => {
  let editing = true;
  while (editing) {
    // Only the ACTIVE account's endpoints are editable rows: the chat enumeration
    // behind the picker is for the active account only, so committing an edit to an
    // endpoint bound to another session would silently replace its scope with this
    // account's picks (a data-loss footgun). Other-account endpoints stay in the
    // draft untouched; switch accounts to edit them.
    const editable = draft.endpoints
      .map((ep, i) => ({ ep, i }))
      .filter(({ ep }) => ep.session === sessionRef);
    const hiddenCount = draft.endpoints.length - editable.length;
    // The endpoints are the menu rows. There is no list-level "Save" row: each
    // completed field edit commits immediately; Back/Esc/← only leaves the list.
    const menuOptions: MenuOption<string>[] = [
      ...editable.map(({ ep, i }) => ({
        value: `${ENDPOINT_ROW_PREFIX}${String(i)}`,
        label: ep.name,
        hint: endpointSummary(ep),
      })),
      { value: 'add', label: '+ Add endpoint', hint: 'create a new virtual group' },
      { value: 'back', label: 'Back', hint: 'finish endpoint editing' },
    ];
    const hiddenNote =
      hiddenCount > 0
        ? ` · ${String(hiddenCount)} on other account(s) hidden (switch account to edit)`
        : '';
    const result = await ui.menu<string>({
      title: 'Endpoints — your virtual groups',
      subtitle:
        editable.length === 0
          ? `No endpoints for this account yet — add one to scope an MCP client · saves apply immediately${hiddenNote}`
          : `${String(editable.length)} endpoint(s) — select to edit/delete · Back/Esc when done${hiddenNote}`,
      options: menuOptions,
    });
    // Esc/← (cancel) leaves the list; the config is already persisted.
    const choice = result.kind === 'selected' ? result.value : 'back';

    if (choice === 'back') {
      editing = false;
    } else if (choice === 'add') {
      const created = await editEndpoint(
        ui,
        draft.endpoints.map((e) => e.name),
        chats,
        folders,
        sessionRef,
      );
      if (created !== undefined) {
        if (draft.endpoints.some((ep) => ep.name === created.name)) {
          ui.notify(`An endpoint named '${created.name}' already exists.`);
        } else {
          draft.endpoints.push(created);
          if (await commitDraft(draft)) {
            // Durability and live policy publication happen before this blocking,
            // shown-once screen. A process exit here cannot lose the endpoint.
            if (created.token !== undefined) {
              await ui.notice(apiKeyNotice(created.name, created.token));
            }
          } else {
            draft.endpoints.pop();
          }
        }
      }
    } else if (choice.startsWith(ENDPOINT_ROW_PREFIX)) {
      const idx = Number(choice.slice(ENDPOINT_ROW_PREFIX.length));
      await editSelectedEndpoint(ui, draft, idx, chats, folders, commitDraft);
    }
  }
};

/**
 * Open the hub-and-spoke editor for one selected endpoint. Each completed spoke
 * commits through the injected save-and-publish boundary. A rejected draft write
 * (for example, a duplicate name) restores the previous in-memory value; a saved
 * draft remains saved even when publication fails, ready for an explicit retry.
 */
const editSelectedEndpoint = async (
  ui: SetupUi,
  draft: ConfigDraft,
  idx: number,
  chats: readonly AccountChatDto[],
  folders: readonly AccountFolderDto[],
  commitDraft: CommitDraft,
): Promise<void> => {
  const current = draft.endpoints[idx];
  if (current === undefined) {
    return;
  }
  await runEndpointHub({
    ui,
    endpoint: current,
    chats,
    folders,
    apply: async (updated): Promise<boolean> => {
      const prev = draft.endpoints[idx];
      draft.endpoints[idx] = updated;
      const ok = await commitDraft(draft);
      if (!ok && prev !== undefined) {
        draft.endpoints[idx] = prev; // revert on schema rejection (e.g. dup name)
      }
      return ok;
    },
    remove: async (): Promise<void> => {
      const removed = draft.endpoints[idx];
      draft.endpoints.splice(idx, 1);
      const ok = await commitDraft(draft);
      if (!ok && removed !== undefined) {
        // The write was rejected — e.g. deleting the last endpoint (the schema
        // requires >=1). Restore the endpoint so the in-memory draft never drifts
        // ahead of disk, and it stays served/listed.
        draft.endpoints.splice(idx, 0, removed);
      }
    },
  });
};

/**
 * Create one endpoint via the linear first-run wizard (the "add" path; editing an
 * existing endpoint goes through the hub in {@link editSelectedEndpoint}). Reuses
 * the same shared field editors as the edit hub: name -> access picker -> mint API
 * key. The caller persists and publishes the result before showing the key. Returns
 * `undefined` when the operator backs out of the access picker.
 */
const editEndpoint = async (
  ui: SetupUi,
  existingNames: readonly string[],
  chats: readonly AccountChatDto[],
  folders: readonly AccountFolderDto[],
  sessionRef: string,
): Promise<EndpointDraft | undefined> => {
  // Pre-fill a name that does not collide with the existing endpoints.
  const name = await promptEndpointName(ui, uniqueEndpointName(existingNames));

  const proj = await runAccessEditor(ui, name, undefined, chats, folders);
  if (proj === undefined) {
    return undefined;
  }

  // Mint a matched {token, tokenHash} pair. Only the hash is persisted; the caller
  // shows the plaintext after the endpoint is durable (never in config.json).
  const { token, tokenHash } = mintEndpointKey();

  return {
    name,
    session: sessionRef,
    ...proj,
    // Human write-confirmation (HITL) is off by default; opt-in per endpoint via
    // the endpoint hub's "Confirm writes" setting, never during create.
    confirmWrites: DEFAULT_CONFIRM_WRITES,
    tokenHash,
    token,
  };
};

// ---------------------------------------------------------------------------
// Save + client-config output
// ---------------------------------------------------------------------------

/**
 * Autosave primitive: validate + atomically write the current draft, with a
 * transient "Saving…" status and notes only on failure. Returns the exact bytes
 * written, so the caller can publish the committed document without a second disk
 * read or a hand-edit race.
 */
const persistDraft = async (
  ui: SetupUi,
  options: SetupOptions,
  draft: ConfigDraft,
): Promise<string | undefined> => {
  const result = await ui.status('Saving…', () =>
    draftRepository(options.configPath).save(draftToConfig(draft)),
  );
  if (isErr(result)) {
    ui.notify(`Change NOT saved: ${result.error.message}`);
    return undefined;
  }
  return result.value;
};

const authenticateOperator = async (
  ui: SetupUi,
  client: OperatorClientPort,
  source: SessionKeySource,
): Promise<boolean> => {
  const connected = await ui.status('Connecting to Telegram MCP…', () =>
    client.connect(),
  );
  if (isErr(connected)) {
    ui.notify(`Cannot reach Telegram MCP: ${connected.error}.`);
    return false;
  }
  const authenticated = await ui.status('Authorizing setup…', () =>
    client.authenticate(source),
  );
  if (isErr(authenticated)) {
    ui.notify(`Setup authorization failed: ${authenticated.error}.`);
    return false;
  }
  return true;
};

/** Publish exact config bytes over an authenticated operator connection. */
const applySavedConfig = async (
  ui: SetupUi,
  client: OperatorClientPort,
  raw: string,
): Promise<boolean> => {
  const applied = await ui.status('Applying config to Telegram MCP…', () =>
    client.applyPolicy(raw),
  );
  if (isErr(applied)) {
    ui.notify(`Config live apply was not confirmed: ${applied.error}`);
    return false;
  }
  ui.notify(`Config applied live (${applied.value.digest.slice(0, 12)}).`);
  return true;
};

/**
 * Apply the config draft to the sealed policy: after config.json is written,
 * validate + seal it under the operator's unlock secret. This is what makes
 * a bare text-editor edit take effect — endpoint-editor saves use the authenticated
 * helper directly, while this public action first authenticates. The runtime trusts
 * the sealed policy, never an unapplied text edit.
 *
 * Exported for the setup-level trigger test; not part of the public CLI surface.
 */
export const applyConfigDraft = async (
  ui: SetupUi,
  options: SetupOptions,
  source: SessionKeySource,
): Promise<boolean> => {
  const client = options.operatorClient;
  if (!(await authenticateOperator(ui, client, source))) return false;
  let raw: string;
  try {
    raw = await readUtf8Bounded(options.configPath);
  } catch (error) {
    ui.notify(
      `Config NOT applied: ${error instanceof Error ? error.message : 'config is unreadable'}`,
    );
    return false;
  }
  return applySavedConfig(ui, client, raw);
};

/**
 * Build the exit summary: one copy-paste config block PER endpoint minted this run
 * (STDERR, human), plus — only when STDOUT is piped — a parseable bundle of those
 * same fresh entries (machine). Emitted after the alt-screen restores.
 *
 * SECURITY: api_id/api_hash are sealed into the session at setup (the daemon reads them
 * from the blob), so they are never inlined here. SMOOTH endpoints carry no session
 * secret. HARDENED endpoints reference only a 0600 *_PASSPHRASE_FILE path (never the
 * PIN itself, never a secret in argv). The JSON block is the only thing on STDOUT.
 */
const buildClientConfigOutput = (
  options: SetupOptions,
  result: LoginResult,
): DeferredOutput => {
  const postureFor = (sessionRef: string): SessionPosture =>
    sessionRef === result.sessionRef
      ? result.posture
      : inferPostureFromSource(options.sessionKey);

  // Only endpoints whose key was minted THIS run are actionable: their block carries
  // the real key. Earlier endpoints' keys are not stored, so printing their config
  // would be dead JSON — they are listed by name instead. One block per endpoint,
  // never a union bundle on screen: the one-endpoint-per-client boundary is enforced
  // by structure, not by a warning.
  const fresh: { readonly name: string; readonly server: Record<string, unknown> }[] =
    [];
  const existing: string[] = [];
  let anyHardened = false;
  for (const ep of result.draft.endpoints) {
    // Token-only block: the API key alone selects and authorizes the endpoint
    // (tokenHash is schema-required, so every endpoint carries one); paths appear
    // only when the operator overrode the central ~/.secure-telegram-mcp home
    // (docker/CI). Absolute paths when present (clients spawn `connect` from
    // their own cwd).
    const env: Record<string, string> = {};
    if (resolve(options.configPath) !== resolve(defaultConfigPath())) {
      env['TELEGRAM_MCP_CONFIG'] = resolve(options.configPath);
    }
    if (resolve(options.sessionDir) !== resolve(defaultSessionDir())) {
      env['TELEGRAM_MCP_SESSION_DIR'] = resolve(options.sessionDir);
    }
    if (postureFor(ep.session) === 'hardened') {
      // No passphrase-file env by default: the PIN is entered interactively via
      // `npx secure-telegram-mcp start` (typed, never on disk). Headless operators can
      // still set TELEGRAM_MCP_SESSION_PASSPHRASE_FILE themselves.
      anyHardened = true;
    }
    if (ep.token === undefined) {
      existing.push(ep.name);
      continue;
    }
    env[ENDPOINT_TOKEN_ENV] = ep.token;
    // `connect` auto-starts the one local daemon and pipes stdio to it — safe for
    // any number of simultaneous MCP clients (Telegram's auth key must have exactly
    // one owner-process).
    fresh.push({
      name: ep.name,
      server: {
        command: 'npx',
        args: ['-y', 'secure-telegram-mcp', 'connect'],
        env,
      },
    });
  }

  const lines: string[] = [''];
  for (const f of fresh) {
    lines.push(
      `Endpoint "${f.name}" — config for its client (key shown once):`,
      '',
      JSON.stringify({ mcpServers: { [`telegram-${f.name}`]: f.server } }, null, 2),
      '',
    );
  }
  if (fresh.length > 1) {
    lines.push('One endpoint per client; merged entries grant the union of scopes.', '');
  }
  if (existing.length > 0) {
    lines.push(
      `Existing endpoints (keys not stored; re-create to mint): ${existing.join(', ')}`,
      '',
    );
  }
  if (anyHardened) {
    lines.push(
      "HARDENED: run 'npx secure-telegram-mcp start' to unlock after boot or idle.",
      '',
    );
  }
  lines.push('Setup complete.', '');

  // Machine surface: a piped STDOUT gets the freshly minted entries as one parseable
  // bundle; a TTY gets nothing on STDOUT — humans copy the per-endpoint blocks above.
  const machineServers: Record<string, unknown> = {};
  for (const f of fresh) machineServers[`telegram-${f.name}`] = f.server;
  const stdout =
    fresh.length > 0 && !process.stdout.isTTY
      ? `${JSON.stringify({ mcpServers: machineServers }, null, 2)}\n`
      : '';

  return { stdout, stderr: lines.join('\n') };
};

/**
 * Emit the client-config block for a completed pass. Overwrite (not append): the
 * main menu loops, so a second pass must replace the block, never emit two
 * concatenated JSON objects on STDOUT.
 */
const emitClientConfig = (
  deferred: DeferredOutput,
  options: SetupOptions,
  result: LoginResult,
): void => {
  const output = buildClientConfigOutput(options, result);
  deferred.stdout = output.stdout;
  deferred.stderr = output.stderr;
  process.exitCode = 0;
};

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

/**
 * The login + endpoint-editing + config-write + client-config-print pass. Returns
 * the verified key source that unlocks the just-logged-in session's app key (so the
 * caller can seed the home menu's unlock cache and skip a redundant PIN prompt), or
 * `undefined` when the pass did not complete.
 */
const runLoginAndConfigure = async (
  ui: SetupUi,
  options: SetupOptions,
  deferred: DeferredOutput,
  posture: OperatorStatusDto['posture'],
  knownSource?: SessionKeySource,
): Promise<SessionKeySource | undefined> => {
  // Acquire the Telegram app credentials interactively (api_hash masked) — never
  // `required()` from the environment (that leaks the secret into shell history).
  // A valid env value is used as a pre-fill default.
  const prompter = new InteractiveCredentialPrompter(credentialConsole(ui));
  const creds = await prompter.acquire({
    apiId: options.apiId,
    apiHash: options.apiHash,
  });
  if (creds === undefined) {
    ui.notify('Telegram app credentials were not provided; aborting login.');
    process.exitCode = 1;
    return undefined;
  }
  const result = await doLogin(ui, options, creds, posture, knownSource);
  if (result === undefined) {
    ui.notify('Login/configuration did not complete.');
    process.exitCode = 1;
    return undefined;
  }
  if (result.draft.endpoints.length === 0) {
    ui.notify('No endpoints defined; nothing to save.');
    process.exitCode = 1;
    return undefined;
  }
  emitClientConfig(deferred, options, result);
  return result.unlockSource;
};

/**
 * Configure endpoints against an existing saved session — no re-login and no
 * re-entry of api creds (both are sealed in the encrypted session). Backs the
 * home-menu "Configure endpoints" action so an already-logged-in operator is never
 * forced to authenticate again.
 */
const configureExistingSession = async (
  ui: SetupUi,
  options: SetupOptions,
  source: SessionKeySource,
  ref: SessionRefValue,
  deferred: DeferredOutput,
): Promise<void> => {
  if (!(await authenticateOperator(ui, options.operatorClient, source))) return;
  const edited = await snapshotAndEdit(ui, options, String(ref));
  if (edited === undefined || edited.draft.endpoints.length === 0) return;
  if (!edited.policyApplied) {
    process.exitCode = 1;
    return;
  }
  const result: LoginResult = {
    draft: edited.draft,
    sessionRef: ref,
    posture: inferPostureFromSource(source),
    unlockSource: source,
  };
  emitClientConfig(deferred, options, result);
};

/** The Accounts submenu outcome: a context switch, an add, a logout, or back. */
type AccountsOutcome =
  | { readonly kind: 'switch'; readonly ref: SessionRefValue }
  | { readonly kind: 'add' }
  | { readonly kind: 'logout' }
  | { readonly kind: 'back' };

/**
 * The accounts switcher: list every authorized account with the active one marked,
 * switch on Enter, plus `Add account` and `Log out`.
 */
const runAccountsMenu = async (
  ui: SetupUi,
  accounts: readonly OperatorAccountDto[],
  activeRef: SessionRefValue,
): Promise<AccountsOutcome> => {
  const options: MenuOption<string>[] = [];
  for (const account of accounts) {
    const ref = account.sessionRef as SessionRefValue;
    const marker = ref === activeRef ? '●' : '○';
    options.push({
      value: `switch:${ref}`,
      label: `${marker} ${accountLabel(account)}`,
      hint: ref === activeRef ? 'active' : 'switch to this account',
    });
  }
  options.push({ value: 'add', label: '+ Add account', hint: 'log in another Telegram account' });
  options.push({
    value: 'logout',
    label: 'Log out (current)',
    hint: 'sign out and remove the active session from this machine',
  });
  options.push({ value: 'back', label: 'Back', hint: 'return to the main menu' });
  const result = await ui.menu<string>({ title: 'Accounts', options });
  const choice = result.kind === 'selected' ? result.value : 'back';
  if (choice.startsWith('switch:')) {
    const ref = choice.slice('switch:'.length) as SessionRefValue;
    return { kind: 'switch', ref };
  }
  if (choice === 'add') return { kind: 'add' };
  if (choice === 'logout') return { kind: 'logout' };
  return { kind: 'back' };
};

/** The wizard's state-aware main-menu loop, driven against the `SetupUi` port. */
const runMainMenu = async (
  ui: SetupUi,
  options: SetupOptions,
  admin: SessionSecurityAdmin,
  deferred: DeferredOutput,
): Promise<void> => {
  const operator = options.operatorClient;
  const connected = await ui.status('Connecting to Telegram MCP…', () =>
    operator.connect(),
  );
  if (isErr(connected)) {
    ui.notify(`Cannot reach Telegram MCP: ${connected.error}.`);
    process.exitCode = 1;
    return;
  }
  let running = true;
  // The active-account context: survives menu loops, falls back to the first
  // session when the chosen one disappears (logout).
  let contextRef: SessionRefValue | undefined;
  // Credential authenticated on this operator socket; cached only for the setup
  // session so hardened actions do not re-prompt between menu screens.
  let unlockedSource: SessionKeySource | undefined;
  const clearUnlock = (): void => {
    unlockedSource = undefined;
  };
  while (running) {
    const status = await operator.status();
    if (isErr(status)) {
      ui.notify(`Could not read Telegram MCP status: ${status.error}.`);
      process.exitCode = 1;
      break;
    }

    // NOT LOGGED IN — no session file on disk. Only login/quit; drop any unlock.
    if (!status.value.hasAccounts) {
      clearUnlock();
      const result = await ui.menu<LoggedOutChoice>({
        title: 'Secure Telegram MCP — setup',
        subtitle: 'Not logged in yet',
        options: LOGGED_OUT_MENU,
      });
      const choice = result.kind === 'selected' ? result.value : 'quit';
      if (choice === 'login') {
        unlockedSource = await runLoginAndConfigure(
          ui,
          options,
          deferred,
          status.value.posture,
        );
      } else {
        running = false;
      }
      continue;
    }

    // Smooth posture needs no operator secret. A configured PIN/keyfile is
    // authenticated once; otherwise hardened setup remains truthfully locked.
    if (unlockedSource === undefined) {
      if (status.value.posture !== 'hardened') {
        unlockedSource = options.sessionKey;
      } else if (options.sessionKey.kind !== 'machine') {
        unlockedSource = await authenticateHardenedOperator(
          ui,
          operator,
          options.sessionKey,
        );
      }
    }

    // Hardened account metadata is itself authenticated, so no ref or label is
    // requested until this operator socket holds the credential.
    if (unlockedSource === undefined) {
      const result = await ui.menu<LockedChoice>({
        title: 'Secure Telegram MCP — setup',
        subtitle: 'Locked — enter PIN to manage Telegram accounts',
        options: LOCKED_MENU,
      });
      const choice = result.kind === 'selected' ? result.value : 'quit';
      if (choice === 'unlock') {
        const source = await authenticateHardenedOperator(
          ui,
          operator,
          options.sessionKey,
        );
        if (source !== undefined) {
          unlockedSource = source;
          ui.notify('Unlocked.');
        }
      } else if (choice === 'login') {
        const source = await runLoginAndConfigure(
          ui,
          options,
          deferred,
          status.value.posture,
        );
        if (source !== undefined) {
          unlockedSource = source;
        }
      } else {
        running = false;
      }
      continue;
    }

    const listed = await operator.listAccounts();
    if (isErr(listed)) {
      ui.notify(`Could not read accounts: ${listed.error}.`);
      process.exitCode = 1;
      break;
    }
    const accounts = listed.value.accounts;
    const refs = accounts.map(
      (account) => account.sessionRef as SessionRefValue,
    );
    const activeRef =
      (contextRef !== undefined && refs.includes(contextRef)
        ? contextRef
        : undefined) ??
      refs.find((ref) => ref === DEFAULT_SESSION_REF) ??
      refs[0];
    if (activeRef === undefined) {
      clearUnlock();
      continue;
    }

    // UNLOCKED — a real channel can open the session, so "Logged in" is truthful.
    const activeAccount = accounts.find(
      (account) => account.sessionRef === String(activeRef),
    );
    const activeLabel =
      activeAccount !== undefined
        ? accountLabel(activeAccount)
        : `session '${activeRef}'`;
    const result = await ui.menu<LoggedInChoice>({
      title: 'Secure Telegram MCP — setup',
      subtitle: `Logged in — ${activeLabel}`,
      options: loggedInMenu(activeLabel),
    });
    // Esc/q on the main menu is the safe default: quit.
    const choice = result.kind === 'selected' ? result.value : 'quit';
    switch (choice) {
      case 'configure':
        await configureExistingSession(
          ui,
          options,
          unlockedSource,
          activeRef,
          deferred,
        );
        break;
      case 'accounts': {
        const outcome = await runAccountsMenu(ui, accounts, activeRef);
        if (outcome.kind === 'switch') {
          contextRef = outcome.ref;
          const selected = accounts.find(
            (account) => account.sessionRef === String(outcome.ref),
          );
          ui.notify(
            `Active account: ${
              selected !== undefined ? accountLabel(selected) : String(outcome.ref)
            }`,
          );
        } else if (outcome.kind === 'add') {
          const source = await runLoginAndConfigure(
            ui,
            options,
            deferred,
            status.value.posture,
            unlockedSource,
          );
          if (source !== undefined) {
            unlockedSource = source;
          }
        } else if (outcome.kind === 'logout') {
          const confirmed = await promptConfirm(ui, {
            title: `Log out of ${activeLabel} and remove session '${activeRef}' from this machine?`,
            defaultValue: false,
          });
          if (confirmed) {
            const removed = await operator.removeAccount(String(activeRef));
            const removalError = isErr(removed) ? removed.error : undefined;
            if (removalError !== undefined) {
              ui.notify(`Could not remove session: ${removalError}`);
            } else {
              ui.notify(`Logged out of ${activeLabel}.`);
            }
          }
        }
        break;
      }
      case 'security':
        if (await runSecurityMenu(ui, options, admin, accounts)) {
          // Add/Change/Remove PIN rewrites the app-key slots, so the cached unlock
          // may no longer match the on-disk state. A plain Back, apply, export, or
          // failed/cancelled mutation keeps the verified unlock.
          clearUnlock();
        }
        break;
      case 'quit':
        running = false;
        break;
    }
  }
  clearUnlock();
  ui.notify('Goodbye.');
};

export const runSetup = async (options: SetupOptions): Promise<void> => {
  // isatty branch (once, at entry). A non-TTY must not block on stdin: it prints the
  // current config + the equivalent flags and exits non-zero. A real terminal
  // launches the single persistent Ink app that owns stdin end to end.
  if (!isInteractiveTty()) {
    await printNonInteractivePlan(options);
    process.exitCode = 1;
    return;
  }
  const operator = options.operatorClient;
  const admin: SessionSecurityAdmin = new OperatorSessionSecurityAdmin(operator);

  // Accumulated during the flow, emitted only after the alt-screen is restored so
  // the copy-paste block + guidance survive on the normal terminal (the alt buffer
  // is discarded on unmount).
  const deferred: DeferredOutput = { stdout: '', stderr: '' };

  // Lazy-load the Ink app — reached only on this TTY path, so `connect` never loads Ink.
  const { runSetupApp } = await import('./ink/run-setup-app.js');
  try {
    await runSetupApp(async (ui: SetupUi) => {
      await runMainMenu(ui, options, admin, deferred);
    });
  } catch {
    process.exit(1);
  } finally {
    operator.close();
  }

  if (deferred.stdout.length > 0) {
    process.stdout.write(deferred.stdout);
  }
  if (deferred.stderr.length > 0) {
    process.stderr.write(`${deferred.stderr}\n`);
  }
};
