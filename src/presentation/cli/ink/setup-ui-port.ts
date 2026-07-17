/**
 * Setup UI port — every setup interaction goes through this one seam so exactly one
 * Ink app ever owns process.stdin (two owners = raw-mode handoff bugs). The flow asks
 * the `SetupUi` for a menu / text / password / confirm / access-picker / status, and a
 * single persistent Ink app renders the matching screen and resolves the request.
 * Framework-free: no React/Ink imports — only plain DTOs (the picker/menu types are
 * type-only imports, erased under `verbatimModuleSyntax`), so this port never loads Ink
 * and the flow stays testable behind a fake `SetupUi`.
 */
import type { MenuRequest, MenuResult } from './ui-port.js';
// Type-only (erased): the picker request/result DTOs live with the picker host, so
// importing this port never loads Ink.
import type {
  AccessPickerRequest,
  AccessPickerResult,
} from './run-access-picker.js';

// Re-export the picker/menu DTOs so a `SetupUi` consumer imports the whole vocabulary
// from this one seam without reaching into the Ink host module.
export type { AccessPickerRequest, AccessPickerResult };
export type { MenuRequest, MenuResult };

// Prompt outcome (mirrors `MenuResult`: a submit carries a value, a cancel does not —
// so a cancel can never be mistaken for an empty submission).

export type PromptResult<T> =
  | { readonly kind: 'submitted'; readonly value: T }
  | { readonly kind: 'cancelled' };

/**
 * A single free-text prompt (session name, phone, login code, endpoint name, api_id, a
 * file path, …). `validate` keeps a bad entry recoverable — the screen shows the error
 * and stays open rather than tearing down and losing the operator's place. `transform`
 * normalises the accepted value (trim / NFC / lowercase) at the seam.
 */
export interface TextPromptRequest {
  readonly title: string;
  readonly subtitle?: string;
  /**
   * Persistent full-contrast context lines rendered on the prompt screen, for guidance
   * the operator must still see while typing (e.g. where to obtain the requested value).
   */
  readonly help?: readonly string[];
  readonly defaultValue?: string;
  /** Return an error string to re-prompt, or `undefined` to accept the value. */
  readonly validate?: (value: string) => string | undefined;
  /** Normalise the raw entry before validation/resolution (trim, NFC, …). */
  readonly transform?: (raw: string) => string;
}

/**
 * A masked secret prompt (2FA password, PIN/passphrase, api_hash). Same contract as
 * `TextPromptRequest` minus a shown default — a secret is never pre-filled or echoed.
 * The rendered field masks every character and the value never reaches the transcript/log.
 */
export interface PasswordPromptRequest {
  readonly title: string;
  readonly subtitle?: string;
  /** Persistent context lines on the prompt screen (see {@link TextPromptRequest.help}). */
  readonly help?: readonly string[];
  readonly validate?: (value: string) => string | undefined;
  readonly transform?: (raw: string) => string;
}

/** A yes/no confirm (write-confirm, "set a PIN?", "keep this login?", …). */
export interface ConfirmPromptRequest {
  readonly title: string;
  readonly subtitle?: string;
  /** Persistent context lines on the prompt screen (see {@link TextPromptRequest.help}). */
  readonly help?: readonly string[];
  /** The default choice when the operator presses Enter without picking y/n. */
  readonly defaultValue: boolean;
}

/**
 * A scannable QR shown while awaiting a QR login. Rendered as one screen element — not
 * the capped rolling note tail, which truncated the top of the code (dropping finder
 * squares) — and at full contrast, since the dimmed transcript colour left it
 * unscannable. `showQr` is non-blocking: the flow awaits the login separately and calls
 * it again on each ~30s token refresh to replace the code in place.
 */
export interface QrRequest {
  readonly title: string;
  /** The pre-rendered QR block (e.g. `qrcode` terminal output). Shown full-contrast. */
  readonly qr: string;
  /** Secondary lines (login URL, PNG-fallback path) — shown dimmed. */
  readonly footer: readonly string[];
  /**
   * Epoch ms when the current login token expires: the screen renders a LIVE
   * per-second countdown line ("token refreshes in Ns…") under the footer —
   * the next `showQr` call replaces the code and resets it.
   */
  readonly expiresAtMs: number;
}

/**
 * A must-read instruction block: the HARDENED PIN-file setup commands to copy, the
 * shown-once API key, an honest posture summary, a config-rejection reason list.
 * Rendered on its own full-contrast screen and blocks until the operator acknowledges
 * (Enter) — so it is never buried in, nor truncated by, the ephemeral status ring.
 */
export interface NoticeRequest {
  /** Bold heading naming the block ("HARDENED posture — PIN file setup", …). */
  readonly title: string;
  /** Body lines rendered full-contrast and un-truncated (copyable, multi-line-safe). */
  readonly body: readonly string[];
}

// The seam

/**
 * The whole interaction surface of setup as one narrow port. Content is split by
 * intent: `notify()` (ephemeral, non-blocking, self-evicting status) and `notice()` (a
 * must-read block that blocks on acknowledgment), plus the `status()` async spinner.
 * Developer diagnostics (GramJS noise) are deliberately absent — a file-only debug sink
 * (`debugLog`) is not a UI concern. STDOUT stays reserved for the final client-config block.
 *
 * The high-level sequence lives in the flow controller that consumes this port; the
 * app's router maps whichever request is active onto its screen. One app renders; one
 * flow drives.
 */
export interface SetupUi {
  /** The reusable arrow-nav SELECT (main menu, login method, security, chooser). */
  menu<T>(request: MenuRequest<T>): Promise<MenuResult<T>>;
  /** A single free-text field with recoverable validation. */
  text(request: TextPromptRequest): Promise<PromptResult<string>>;
  /** A masked secret field (never echoed or logged). */
  password(request: PasswordPromptRequest): Promise<PromptResult<string>>;
  /** A yes/no confirm. */
  confirm(request: ConfirmPromptRequest): Promise<PromptResult<boolean>>;
  /** The hard step: the pruned-tree access picker -> security-first review gate. */
  pickAccess(request: AccessPickerRequest): Promise<AccessPickerResult>;
  /**
   * Push one ephemeral status line into the bounded self-evicting ring (non-blocking).
   * For transient one-liners ("Logged in as X", "Found N dialogs", cancels, recoverable
   * errors). The oldest line drops off automatically, so it never becomes a scroll pile.
   */
  notify(line: string): void;
  /**
   * Show a must-read block on its own full-contrast screen and resolve only once the
   * operator acknowledges (Enter). Awaited like `menu()`/`confirm()`. For the HARDENED
   * PIN-file commands, the shown-once API key, posture summaries, config-rejection reasons.
   */
  notice(request: NoticeRequest): Promise<void>;
  /**
   * Show a scannable QR as its own full-contrast screen (non-blocking); calling it again
   * replaces the code in place, so the code is never truncated by the note tail nor
   * dimmed unscannable.
   */
  showQr(request: QrRequest): void;
  /** Show a spinner labelled `label` for the duration of `task`, then clear it. */
  status<T>(label: string, task: () => Promise<T>): Promise<T>;
}
