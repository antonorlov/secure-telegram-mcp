/**
 * The golden menu matrix: which rows the wizard offers in each state, and — the reason this
 * suite exists — which rows it must NOT. A menu is a projection of the store's state, so the
 * wrong row in the wrong state is the operator-facing twin of a leaked capability: claiming
 * "Logged in" over a locked store, or offering a session action with no unlock channel, is a
 * lie the operator will act on. Driven through the `SetupUi` port, so the whole matrix costs
 * milliseconds and no terminal.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionKeySource } from '../../src/application/index.js';
import { runSetup, type SetupOptions } from '../../src/presentation/cli/setup.js';
import { runEndpointHub } from '../../src/presentation/cli/endpoint-hub.js';
import type { EndpointDraft } from '../../src/presentation/cli/endpoint-draft.js';
import type { OperatorClientPort } from '../../src/presentation/operator/client.js';
import type { SetupUi } from '../../src/presentation/cli/ink/setup-ui-port.js';
import { CANCEL, MenuRecorder, expectMenu } from '../_support/menu-recorder.js';

// The mock factory is hoisted above the imports, so the per-test recorder reaches it through
// this holder rather than being constructed inside it.
const H = vi.hoisted(() => ({ ui: undefined as SetupUi | undefined }));

// The whole interactive surface is the one persistent Ink app behind `runSetupApp`. Stubbing
// that seam hands the flow the recording port instead of a terminal.
vi.mock('../../src/presentation/cli/ink/run-setup-app.js', () => ({
  runSetupApp: (flow: (ui: SetupUi) => Promise<void>): Promise<void> => {
    if (H.ui === undefined) {
      throw new Error('no recorder installed for this run');
    }
    return flow(H.ui);
  },
}));

type Posture = 'none' | 'smooth' | 'hardened';

interface OperatorState {
  posture: Posture;
  hasAccounts: boolean;
  accounts: readonly { readonly sessionRef: string; readonly label: string }[];
  // False models a credential the daemon rejects: the UI must stay locked.
  authenticates: boolean;
}

const notCalled = (method: string) => (): never => {
  throw new Error(`the matrix flow called operator.${method}`);
};

// Only the read paths the menu states depend on are real; every mutating call is a trap,
// because navigating a matrix must never change the store.
const makeOperator = (state: OperatorState): OperatorClientPort =>
  ({
    connect: () => Promise.resolve({ ok: true, value: undefined }),
    status: () =>
      Promise.resolve({
        ok: true,
        value: {
          posture: state.posture,
          locked: state.posture === 'hardened' && !state.authenticates,
          hasAccounts: state.hasAccounts,
        },
      }),
    listAccounts: () => Promise.resolve({ ok: true, value: { accounts: state.accounts } }),
    authenticate: () =>
      Promise.resolve(
        state.authenticates
          ? { ok: true, value: undefined }
          : { ok: false, error: 'bad credential' },
      ),
    snapshotAccount: () =>
      Promise.resolve({
        ok: true,
        value: { chats: [{ id: '-100123', title: 'Team', kind: 'group' }], folders: [] },
      }),
    login: notCalled('login'),
    commitLogin: notCalled('commitLogin'),
    cancelLogin: notCalled('cancelLogin'),
    applyPolicy: notCalled('applyPolicy'),
    removeAccount: notCalled('removeAccount'),
    setPin: notCalled('setPin'),
    changePin: notCalled('changePin'),
    removePin: notCalled('removePin'),
    exportRecovery: notCalled('exportRecovery'),
    close: () => undefined,
  }) as unknown as OperatorClientPort;

const ORIGINAL_STDIN_TTY = process.stdin.isTTY;
const ORIGINAL_STDERR_TTY = process.stderr.isTTY;
const ORIGINAL_EXIT_CODE = process.exitCode;

let dir = '';

const optionsFor = (
  state: OperatorState,
  sessionKey: SessionKeySource = { kind: 'machine' },
): SetupOptions => ({
  configPath: join(dir, 'config.json'),
  sessionDir: join(dir, 'sessions'),
  sessionKey,
  operatorClient: makeOperator(state),
});

/**
 * Runs the wizard against a scripted recorder. `runSetup` swallows a thrown error and exits,
 * so the recorder's own reason is re-raised first — a mis-scripted flow must read as the menu
 * it could not answer, not as a bare exit.
 */
const drive = async (
  script: readonly string[],
  options: SetupOptions,
): Promise<MenuRecorder> => {
  const recorder = new MenuRecorder(script);
  H.ui = recorder.ui;
  let crashed: unknown;
  try {
    await runSetup(options);
  } catch (error) {
    crashed = error;
  }
  if (recorder.failure !== undefined) throw recorder.failure;
  if (crashed !== undefined) {
    throw crashed instanceof Error ? crashed : new Error(JSON.stringify(crashed));
  }
  return recorder;
};

const ONE_ACCOUNT = [{ sessionRef: 'main', label: 'Ada (+79990000001)' }] as const;
const TWO_ACCOUNTS = [
  { sessionRef: 'main', label: 'Ada (+79990000001)' },
  { sessionRef: 'work', label: 'Grace (+79990000002)' },
] as const;

const PASSPHRASE: SessionKeySource = { kind: 'passphrase', passphrase: 'correct-horse' };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tg-mcp-menus-'));
  process.stdin.isTTY = true;
  process.stderr.isTTY = true;
  // The wizard exits the process on an unexpected throw; make that observable instead.
  vi.spyOn(process, 'exit').mockImplementation(((code?: number): never => {
    throw new Error(`setup exited with ${String(code)}`);
  }) as never);
});

afterEach(async () => {
  vi.restoreAllMocks();
  H.ui = undefined;
  process.stdin.isTTY = ORIGINAL_STDIN_TTY;
  process.stderr.isTTY = ORIGINAL_STDERR_TTY;
  process.exitCode = ORIGINAL_EXIT_CODE;
  await rm(dir, { recursive: true, force: true });
});

describe('home menu — one projection per store state', () => {
  it('offers only Log in and Quit when no session exists', async () => {
    const recorder = await drive(
      ['quit'],
      optionsFor({
        posture: 'none',
        hasAccounts: false,
        accounts: [],
        authenticates: true,
      }),
    );
    expectMenu(recorder.at(0), {
      title: 'Secure Telegram MCP — setup',
      subtitle: 'Not logged in yet',
      rows: ['Log in', 'Quit'],
      mustNotContain: [
        'Logged in',
        'Configure endpoints',
        'Session security',
        'Enter PIN',
      ],
    });
    expect(recorder.menus).toHaveLength(1);
  });

  it('claims "Logged in" and offers session actions on a smooth store', async () => {
    const recorder = await drive(
      ['quit'],
      optionsFor({
        posture: 'smooth',
        hasAccounts: true,
        accounts: ONE_ACCOUNT,
        authenticates: true,
      }),
    );
    expectMenu(recorder.at(0), {
      title: 'Secure Telegram MCP — setup',
      subtitle: /^Logged in — Ada/,
      rows: ['Configure endpoints', 'Accounts', 'Session security', 'Quit'],
      mustNotContain: ['Locked', 'Enter PIN', 'Log in again'],
    });
  });

  it('stays locked — and says so — on a hardened store with no unlock channel', async () => {
    const recorder = await drive(
      ['quit'],
      optionsFor({
        posture: 'hardened',
        hasAccounts: true,
        accounts: ONE_ACCOUNT,
        authenticates: true,
      }),
    );
    expectMenu(recorder.at(0), {
      title: 'Secure Telegram MCP — setup',
      subtitle: 'Locked — enter PIN to manage Telegram accounts',
      rows: ['Enter PIN', 'Log in again', 'Quit'],
      mustNotContain: [
        'Logged in',
        'Configure endpoints',
        'Session security',
        'Accounts',
        // The locked screen is drawn before `listAccounts`, so no label can be on it.
        'Ada',
      ],
    });
  });

  it('unlocks the same store when the configured credential authenticates', async () => {
    const recorder = await drive(
      ['quit'],
      optionsFor(
        {
          posture: 'hardened',
          hasAccounts: true,
          accounts: ONE_ACCOUNT,
          authenticates: true,
        },
        PASSPHRASE,
      ),
    );
    expectMenu(recorder.at(0), {
      subtitle: /^Logged in — Ada/,
      rows: ['Configure endpoints', 'Accounts', 'Session security', 'Quit'],
      mustNotContain: ['Locked'],
    });
  });

  it('falls back to the locked projection when that credential is rejected', async () => {
    const recorder = await drive(
      ['quit'],
      optionsFor(
        {
          posture: 'hardened',
          hasAccounts: true,
          accounts: ONE_ACCOUNT,
          authenticates: false,
        },
        PASSPHRASE,
      ),
    );
    expectMenu(recorder.at(0), {
      subtitle: 'Locked — enter PIN to manage Telegram accounts',
      rows: ['Enter PIN', 'Log in again', 'Quit'],
      mustNotContain: ['Logged in', 'Configure endpoints'],
    });
  });

  it('treats Esc on the home menu as quit, not as a silent fall-through', async () => {
    const recorder = await drive(
      [CANCEL],
      optionsFor({
        posture: 'smooth',
        hasAccounts: true,
        accounts: ONE_ACCOUNT,
        authenticates: true,
      }),
    );
    expect(recorder.menus).toHaveLength(1);
  });
});

describe('session-security menu — posture gates every row', () => {
  it('offers only Add PIN on a smooth store', async () => {
    const recorder = await drive(
      ['security', 'back', 'quit'],
      optionsFor({
        posture: 'smooth',
        hasAccounts: true,
        accounts: ONE_ACCOUNT,
        authenticates: true,
      }),
    );
    expectMenu(recorder.at(1), {
      title: 'Session security',
      rows: ['Add PIN', 'Apply config changes', 'Back'],
      mustNotContain: ['Change PIN', 'Remove PIN', 'Export recovery keyfile'],
    });
  });

  it('offers change, remove and export — never Add — on a hardened store', async () => {
    const recorder = await drive(
      ['security', 'back', 'quit'],
      optionsFor(
        {
          posture: 'hardened',
          hasAccounts: true,
          accounts: ONE_ACCOUNT,
          authenticates: true,
        },
        PASSPHRASE,
      ),
    );
    expectMenu(recorder.at(1), {
      title: 'Session security',
      rows: [
        'Change PIN',
        'Remove PIN',
        'Export recovery keyfile',
        'Apply config changes',
        'Back',
      ],
      mustNotContain: ['Add PIN'],
    });
  });

  it('says how many accounts the one PIN protects when there is more than one', async () => {
    const recorder = await drive(
      ['security', 'back', 'quit'],
      optionsFor({
        posture: 'smooth',
        hasAccounts: true,
        accounts: TWO_ACCOUNTS,
        authenticates: true,
      }),
    );
    expectMenu(recorder.at(1), { subtitle: /all 2 accounts/ });
  });
});

describe('accounts menu — the active context is marked and switchable', () => {
  it('marks the active account, offers the others, and moves the marker on a switch', async () => {
    const state: OperatorState = {
      posture: 'smooth',
      hasAccounts: true,
      accounts: TWO_ACCOUNTS,
      authenticates: true,
    };
    const recorder = await drive(
      ['accounts', 'switch:work', 'accounts', 'back', 'quit'],
      optionsFor(state),
    );
    expectMenu(recorder.at(1), {
      title: 'Accounts',
      rows: [
        '● Ada (+79990000001)',
        '○ Grace (+79990000002)',
        '+ Add account',
        'Log out (current)',
        'Back',
      ],
    });
    // After the switch the home menu names the new context and the marker follows it.
    expectMenu(recorder.at(2), { subtitle: /^Logged in — Grace/ });
    expectMenu(recorder.at(3), {
      rows: [
        '○ Ada (+79990000001)',
        '● Grace (+79990000002)',
        '+ Add account',
        'Log out (current)',
        'Back',
      ],
    });
  });
});

describe('endpoint list — only the active account is editable', () => {
  const OTHER = 'work-only-endpoint';
  const configWithTwoAccounts = {
    version: 1,
    endpoints: [
      {
        name: 'main-reader',
        session: 'main',
        tokenHash: `${'a'.repeat(32)}$${'0123456789abcdef'.repeat(4)}`,
        scope: { chats: ['me'], folders: [] },
        verbs: ['read'],
      },
      {
        name: OTHER,
        session: 'work',
        tokenHash: `${'b'.repeat(32)}$${'0123456789abcdef'.repeat(4)}`,
        scope: { chats: ['me'], folders: [] },
        verbs: ['read'],
      },
    ],
  };

  it('lists this account\'s endpoints, hides the other account\'s, and says how many', async () => {
    await writeFile(join(dir, 'config.json'), JSON.stringify(configWithTwoAccounts), 'utf8');
    const recorder = await drive(
      ['configure', 'back', 'quit'],
      optionsFor(
        {
          posture: 'smooth',
          hasAccounts: true,
          accounts: TWO_ACCOUNTS,
          authenticates: true,
        },
      ),
    );
    expectMenu(recorder.at(1), {
      title: 'Endpoints — your virtual groups',
      subtitle: /1 on other account\(s\) hidden/,
      rows: ['main-reader', '+ Add endpoint', 'Back'],
      mustNotContain: [OTHER],
    });
  });
});

describe('endpoint hub — rows follow the endpoint, not the operator', () => {
  const baseDraft: EndpointDraft = {
    name: 'support-reader',
    session: 'main',
    chats: [],
    folders: [],
    verbs: ['read'],
    confirmWrites: false,
    chatOverrides: [],
    tokenHash: `${'a'.repeat(32)}$${'0123456789abcdef'.repeat(4)}`,
  };

  const openHub = async (
    endpoint: EndpointDraft,
    script: readonly string[],
  ): Promise<MenuRecorder> => {
    const recorder = new MenuRecorder(script);
    await runEndpointHub({
      ui: recorder.ui,
      endpoint,
      chats: [],
      folders: [],
      apply: () => Promise.resolve(true),
      remove: () => Promise.resolve(),
    });
    if (recorder.failure !== undefined) throw recorder.failure;
    return recorder;
  };

  it('hides the write confirmation row on a read-only endpoint', async () => {
    const recorder = await openHub(baseDraft, ['back']);
    expectMenu(recorder.at(0), {
      title: 'Endpoint "support-reader"',
      rows: [
        'Name',
        'Access — chats & folders',
        'API key',
        'Delete endpoint (danger)',
        'Back',
      ],
      mustNotContain: ['Confirm writes'],
    });
  });

  it('shows it, with its current setting, as soon as a write verb is granted', async () => {
    const recorder = await openHub(
      { ...baseDraft, verbs: ['read', 'send'], confirmWrites: true },
      ['back'],
    );
    expectMenu(recorder.at(0), {
      rows: [
        'Name',
        'Access — chats & folders',
        'Confirm writes (HITL)',
        'API key',
        'Delete endpoint (danger)',
        'Back',
      ],
      subtitle: /confirmWrites on/,
    });
    expect(recorder.at(0)?.hints).toContain('on');
  });

  it('shows it for a write granted to a single chat by an override', async () => {
    const recorder = await openHub(
      {
        ...baseDraft,
        chats: [{ kind: 'me' }],
        chatOverrides: [{ peer: { kind: 'me' }, verbs: ['read', 'send'] }],
      },
      ['back'],
    );
    expect(recorder.at(0)?.labels).toContain('Confirm writes (HITL)');
  });

  it('never prints a whole API key: a reloaded endpoint has only the hash to show', async () => {
    const recorder = await openHub(baseDraft, ['back']);
    const menu = recorder.at(0);
    expect(menu?.hints[menu.labels.indexOf('API key')]).toBe(
      'set — Regenerate to replace',
    );
    expectMenu(menu, { mustNotContain: [baseDraft.tokenHash] });
  });

  it('previews a key minted this session as a truncated fingerprint, never in full', async () => {
    const token = 'tgmcp_abcdefghijklmnopqrstuvwxyz012345';
    const recorder = await openHub({ ...baseDraft, token }, ['back']);
    const menu = recorder.at(0);
    expect(menu?.hints[menu.labels.indexOf('API key')]).toBe('tgmcp_abc…2345');
    expectMenu(menu, { mustNotContain: [token] });
  });
});
