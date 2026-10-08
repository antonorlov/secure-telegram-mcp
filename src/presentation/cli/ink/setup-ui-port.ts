/**
 * Every setup interaction goes through this one seam, so exactly one Ink app ever owns
 * process.stdin — two owners cause raw-mode handoff bugs. The flow asks for a menu, text,
 * password, confirm, access picker or status, and a single mounted app answers.
 */
import type { MenuRequest, MenuResult } from './ui-port.js';
// Type-only (erased): the picker request/result DTOs live with the picker host, so
// importing this port never loads Ink.
import type {
  AccessPickerRequest,
  AccessPickerResult,
} from './run-access-picker.js';

// Re-exported so a `SetupUi` consumer imports the whole vocabulary from this one seam, without
// reaching into the Ink host module.
export type { AccessPickerRequest, AccessPickerResult };
export type { MenuRequest, MenuResult };

// Prompt outcome (mirrors `MenuResult`: a submit carries a value, a cancel does not —
// so a cancel can never be mistaken for an empty submission).
export type PromptResult<T> =
  | { readonly kind: 'submitted'; readonly value: T }
  | { readonly kind: 'cancelled' };

// `validate` keeps a bad entry recoverable: the screen shows the error and stays open instead
// of tearing down and losing the operator's place.
export interface TextPromptRequest {
  readonly title: string;
  readonly subtitle?: string;
  // Persistent full-contrast context lines on the prompt screen, for guidance the operator must
  // still see while typing.
  readonly help?: readonly string[];
  readonly defaultValue?: string;
  // Return an error string to re-prompt, or `undefined` to accept the value.
  readonly validate?: (value: string) => string | undefined;
  // Normalise the raw entry before validation/resolution (trim, NFC, …).
  readonly transform?: (raw: string) => string;
}

// The same contract as a text prompt minus a shown default: a secret is never pre-filled or
// echoed, the field masks every character, and the value never reaches the transcript.
export type PasswordPromptRequest = Omit<TextPromptRequest, 'defaultValue'>;

export interface ConfirmPromptRequest
  extends Pick<TextPromptRequest, 'title' | 'subtitle' | 'help'> {
  // The default choice when the operator presses Enter without picking y/n.
  readonly defaultValue: boolean;
}

/**
 * Rendered as one screen element, not the capped rolling note tail, which truncated the top of
 * the code and dropped its finder squares — and at full contrast, since the dimmed transcript
 * colour left it unscannable.
 */
export interface QrRequest {
  readonly title: string;
  readonly qr: string;
  // Secondary lines (login URL, PNG-fallback path) — shown dimmed.
  readonly footer: readonly string[];
  // Epoch ms when the current login token expires: the screen renders a live per-second
  // countdown, and the next `showQr` call replaces the code and resets it.
  readonly expiresAtMs: number;
}

// A must-read instruction block on its own full-contrast screen, blocking until the operator
// acknowledges.
export interface NoticeRequest {
  readonly title: string;
  // Body lines rendered full-contrast and un-truncated — copyable and multi-line-safe.
  readonly body: readonly string[];
}

/**
 * The whole interaction surface of setup as one narrow port, split by intent: `notify()` is
 * ephemeral, non-blocking and self-evicting, `notice()` is a must-read block that waits for
 * acknowledgment, and `status()` is the async spinner.
 */
export interface SetupUi {
  menu<T>(request: MenuRequest<T>): Promise<MenuResult<T>>;
  text(request: TextPromptRequest): Promise<PromptResult<string>>;
  password(request: PasswordPromptRequest): Promise<PromptResult<string>>;
  confirm(request: ConfirmPromptRequest): Promise<PromptResult<boolean>>;
  pickAccess(request: AccessPickerRequest): Promise<AccessPickerResult>;
  // The oldest line drops off automatically, so transient status never becomes a scroll pile.
  notify(line: string): void;
  notice(request: NoticeRequest): Promise<void>;
  // Calling it again replaces the code in place, so the QR is never truncated by the note tail
  // nor dimmed unscannable.
  showQr(request: QrRequest): void;
  status<T>(label: string, task: () => Promise<T>): Promise<T>;
}
