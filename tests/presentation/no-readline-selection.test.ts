/**
 * GUARD — `setup.ts` owns NO stdin of its own: every interaction flows through
 * the ONE persistent Ink app via the framework-free `SetupUi` port. This is the
 * fail-closed net for the root-cause fix.
 *
 * THE BUG this guards against: setup used to mix an Ink app (arrow-nav menus +
 * the tree picker) with a readline `Console` for text/secret prompts. BOTH bound
 * `process.stdin` in raw mode, so when an Ink screen unmounted its raw-mode
 * teardown left readline dead and the NEXT prompt hit EOF — the process exited
 * silently ("the app quits when you move in the menu"). Unit/snapshot tests never
 * caught it because they drove a fake stdin, never the wired interactive flow.
 *
 * A source-scan is the right tool: the defect is "a SECOND stdin owner (readline)
 * is still WIRED", which no behavioural test over the pure reducer/mapper or an
 * Ink component in isolation can observe. We assert the current source contract:
 *
 *   • DELETED — every `node:readline` import/usage, `createInterface`, the
 *     readline-backed `Console` class, and the OLD numbered readline selection
 *     surfaces (`pickFolders` / `parseIndices` and their prompt strings) are gone.
 *     (The narrow `CredentialPromptConsole` port survives, but backed by an
 *     adapter over `SetupUi` — text/password — not by readline.)
 *   • CONVERTED — the wizard depends on the single `SetupUi` seam and drives the
 *     one Ink app (`runSetupApp`): menus via `ui.menu`, text via `ui.text`,
 *     secrets via `ui.password`, confirms via `ui.confirm`, and the folder→chat
 *     access picker + review gate via `ui.pickAccess` (the folder→chat hierarchy
 *     flows INTO the single tree via `buildPickerTree`).
 *
 * SCOPE: the wizard's I/O surface is the flow (`setup.ts`) PLUS the extracted
 * per-field editor modules it shares with the edit hub (`endpoint-draft.ts`,
 * `endpoint-hub.ts`). All three depend only on the `SetupUi` port — the access
 * picker glue (`ui.pickAccess` / `buildPickerTree`) moved into `endpoint-draft.ts`
 * when it became shared between the creation wizard and the edit hub — so the
 * guard scans their union: FORBIDDEN tokens absent from every file, REQUIRED
 * tokens present somewhere in the surface.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The wizard's whole I/O surface (flow + extracted shared editors), concatenated. */
const CLI_DIR = join(process.cwd(), 'src', 'presentation', 'cli');
const SURFACE_FILES = ['setup.ts', 'endpoint-draft.ts', 'endpoint-hub.ts'];
const source = SURFACE_FILES.map((f) => readFileSync(join(CLI_DIR, f), 'utf8')).join(
  '\n',
);

/**
 * SECOND-STDIN-OWNER surfaces that MUST be gone: any readline usage (the whole
 * point of the fix) and the OLD numbered-list selection machinery.
 */
const FORBIDDEN: readonly { readonly token: string; readonly why: string }[] = [
  {
    token: 'node:readline',
    why: 'readline is the second stdin owner whose raw-mode handoff caused the silent-exit bug — the ONE Ink app now owns stdin',
  },
  {
    token: 'createInterface',
    why: 'the readline interface factory must never be re-imported (its raw-mode teardown left the next prompt dead)',
  },
  {
    token: 'class Console',
    why: 'the readline-backed Console class is deleted; the flow depends on the SetupUi port instead',
  },
  {
    token: 'pickFolders',
    why: 'the OLD readline folder chooser — folder selection now happens IN the Ink pruned tree, not a numbered list',
  },
  {
    token: 'parseIndices',
    why: 'the comma-separated index parser that ONLY fed the old numbered pickers (dead once both are gone)',
  },
  {
    token: 'Select folder numbers',
    why: 'the OLD readline folder-list prompt string ("Select folder numbers (comma-separated):")',
  },
  {
    token: 'Endpoint number',
    why: 'the OLD readline endpoint-chooser prompt string ("Endpoint number:") — now an arrow-nav ui.menu',
  },
];

/**
 * The single-Ink-app surfaces that MUST be present — proving ALL interaction
 * (selection AND entry) moved onto the one `SetupUi` seam rather than merely
 * being deleted.
 */
const REQUIRED: readonly { readonly token: string; readonly why: string }[] = [
  {
    token: 'runSetupApp',
    why: 'setup drives the ONE persistent Ink app that owns stdin start to finish (no second owner)',
  },
  {
    token: 'ui.menu<',
    why: 'every choice menu (main/login-method/security/endpoint chooser) is the arrow-nav ui.menu',
  },
  {
    token: 'ui.text(',
    why: 'free-text entry (session/endpoint name, phone, login code) is the Ink text field',
  },
  {
    token: 'ui.password(',
    why: 'masked secret entry (2FA, PIN, api_hash) is the Ink password field',
  },
  {
    token: 'ui.confirm(',
    why: 'y/N consent (write-confirm, set-a-PIN, keep-login) is the Ink confirm field',
  },
  {
    token: 'ui.pickAccess(',
    why: 'chat/folder scope + per-chat r/w is chosen in the Ink picker → review gate screen',
  },
  {
    token: 'buildPickerTree(chats, folders)',
    why: 'folders flow INTO the single Ink tree (the folder→chat hierarchy) — one selection surface, no separate readline folder step',
  },
];

describe('setup.ts — no second stdin owner survives (all I/O flows through the one Ink app)', () => {
  it.each(FORBIDDEN)(
    'has removed the readline / numbered-selection surface `$token`',
    ({ token, why }) => {
      expect(source, `\`${token}\` must be gone: ${why}`).not.toContain(token);
    },
  );

  it.each(REQUIRED)(
    'routes interaction through the single Ink app surface `$token`',
    ({ token, why }) => {
      expect(source, `\`${token}\` must be present: ${why}`).toContain(token);
    },
  );

  it('never re-adds a prompt that asks the operator to type a NUMBER to pick from a list', () => {
    // A defensive catch-all: any single-line string literal telling the user to
    // type a number / comma-separated numbers to choose from a list is, by
    // definition, a numbered selection menu and belongs in the arrow-nav ui.menu,
    // not a text field. Line-scoped (`[^…\n]`) so a stray apostrophe in prose
    // cannot open a spurious multi-line "string".
    const NUMBERED_LIST_PROMPT =
      /(['"`])[^'"`\n]*(?:number[s]?\b[^'"`\n]*(?:comma|separated|choose|select|pick)|(?:comma|separated)[^'"`\n]*number)[^'"`\n]*\1/i;
    expect(source).not.toMatch(NUMBERED_LIST_PROMPT);
  });
});
