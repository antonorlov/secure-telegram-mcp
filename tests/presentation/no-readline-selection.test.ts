/**
 * GUARD — `setup.ts` owns NO stdin of its own: every interaction flows through the ONE
 * persistent Ink app via the framework-free `SetupUi` port.
 * The bug this guards against: setup used to mix an Ink app with readline, so two owners of
 * process.stdin fought over raw mode. This test fails closed if either the readline machinery
 * or the old numbered-list selection comes back.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CLI_DIR = join(process.cwd(), 'src', 'presentation', 'cli');
const SURFACE_FILES = ['setup.ts', 'endpoint-draft.ts', 'endpoint-hub.ts'];
const source = SURFACE_FILES.map((f) => readFileSync(join(CLI_DIR, f), 'utf8')).join(
  '\n',
);

// Second-stdin-owner surfaces that MUST be gone: any readline usage, and the old numbered-list
// selection machinery.
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

// The single-Ink-app surfaces that MUST be present — proving all interaction moved onto the one
// `SetupUi` seam rather than merely being deleted.
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
    /**
     * A defensive catch-all: any single-line literal telling the operator to type a number to
     * choose from a list is a numbered selection menu by definition, and belongs in the
     * arrow-nav `ui.menu`, not a text field.
     */
    const NUMBERED_LIST_PROMPT =
      /(['"`])[^'"`\n]*(?:number[s]?\b[^'"`\n]*(?:comma|separated|choose|select|pick)|(?:comma|separated)[^'"`\n]*number)[^'"`\n]*\1/i;
    expect(source).not.toMatch(NUMBERED_LIST_PROMPT);
  });
});
