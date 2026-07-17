/**
 * Endpoint EDIT HUB — unit-drives `runEndpointHub` against a queue-scripted fake
 * `SetupUi` (the same style as setup-mode.test.ts's `makeSetupUi`) with spy
 * `apply`/`remove` callbacks. It exercises every spoke of the hub-and-spoke
 * editor and the LIVE-APPLY + AUTOSAVE + re-render contract:
 *
 *   - each spoke edits the right field, calls `apply` once, and the hub RE-RENDERS
 *     the new value in the next menu's row hints;
 *   - Access opens the picker (the permission SSOT) and projects read / read+write;
 *   - Confirm-writes toggles; the API-key spoke shows the key ONLY while it is held
 *     in memory this session (never persisted — config keeps only the hash) and is
 *     REGENERATE-ONLY for a reloaded endpoint; Regenerate mints a NEW matched pair
 *     (REAL endpoint-token: asserts the hash changed AND still verifies);
 *   - Delete confirms then removes; Back (and Esc) just exit;
 *   - a REJECTED apply (schema-invalid, e.g. a dup rename) keeps the OLD value.
 *
 * Synthetic ENGLISH fixtures + fake ids only (Alice, -1001000000001, tgmcp_ keys).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  runEndpointHub,
  type EndpointHubDeps,
} from '../../src/presentation/cli/endpoint-hub.js';
import {
  accessHint,
  mintEndpointKey,
  truncateKey,
  uniqueEndpointName,
  type EndpointDraft,
} from '../../src/presentation/cli/endpoint-draft.js';
import { endpointTokenMatches } from '../../src/infrastructure/endpoint-token.js';
import { ChatId, PeerRefFactory, type PeerRef } from '../../src/domain/index.js';
import { unwrap } from '../../src/shared/result.js';
import type {
  AccountChatDto as SetupChat,
  AccountFolderDto as SetupFolder,
} from '../../src/application/index.js';
import type {
  MenuRequest,
  MenuResult,
} from '../../src/presentation/cli/ink/ui-port.js';
import type {
  AccessPickerRequest,
  AccessPickerResult,
  NoticeRequest,
  PromptResult,
  SetupUi,
} from '../../src/presentation/cli/ink/setup-ui-port.js';
import type {
  AccessBits,
  ChatKey,
} from '../../src/presentation/cli/picker/index.js';

// ---------------------------------------------------------------------------
// Synthetic fixtures (fake ids + English titles only — never real data).
// ---------------------------------------------------------------------------

const CHAT_ID = '-1001000000001';
const CHATS: readonly SetupChat[] = [
  { id: CHAT_ID, title: 'Team', kind: 'group' },
];
const FOLDERS: readonly SetupFolder[] = [];

/** The domain PeerRef form the draft holds for the fixture chat. */
const chatRef = (raw: string): PeerRef =>
  PeerRefFactory.fromId(unwrap(ChatId.fromString(raw)));

const baseEndpoint = (over: Partial<EndpointDraft> = {}): EndpointDraft => {
  const { token, tokenHash } = mintEndpointKey();
  return {
    name: 'reader',
    session: 'main',
    chats: [chatRef(CHAT_ID)],
    folders: [],
    verbs: ['read'],
    confirmWrites: true,
    chatOverrides: [],
    tokenHash,
    token,
    ...over,
  };
};

// ---------------------------------------------------------------------------
// Queue-scripted fake SetupUi (records menu requests so re-render hints can be
// asserted; menu/text/confirm dequeue scripted answers; pickAccess is injected).
// ---------------------------------------------------------------------------

interface UiScript {
  readonly menu?: readonly string[];
  readonly text?: readonly string[];
  readonly confirm?: readonly boolean[];
  readonly pickAccess?: (req: AccessPickerRequest) => AccessPickerResult;
}

interface FakeUi {
  readonly ui: SetupUi;
  readonly menuRequests: MenuRequest<string>[];
  readonly notices: NoticeRequest[];
}

const makeUi = (script: UiScript): FakeUi => {
  const menuQueue = [...(script.menu ?? [])];
  const textQueue = [...(script.text ?? [])];
  const confirmQueue = [...(script.confirm ?? [])];
  const menuRequests: MenuRequest<string>[] = [];
  const notices: NoticeRequest[] = [];

  const ui: SetupUi = {
    menu: <T,>(request: MenuRequest<T>): Promise<MenuResult<T>> => {
      menuRequests.push(request as unknown as MenuRequest<string>);
      const choice = menuQueue.shift();
      if (choice === undefined) {
        throw new Error('hub opened more menus than were scripted');
      }
      return Promise.resolve(
        choice === '__cancel__'
          ? { kind: 'cancelled' }
          : { kind: 'selected', value: choice as T },
      );
    },
    text: (): Promise<PromptResult<string>> => {
      const value = textQueue.shift();
      if (value === undefined) {
        throw new Error('hub asked for more text than was scripted');
      }
      return Promise.resolve({ kind: 'submitted', value });
    },
    password: (): Promise<PromptResult<string>> =>
      Promise.resolve({ kind: 'cancelled' }),
    confirm: (): Promise<PromptResult<boolean>> => {
      const value = confirmQueue.shift();
      if (value === undefined) {
        throw new Error('hub asked for more confirms than was scripted');
      }
      return Promise.resolve({ kind: 'submitted', value });
    },
    pickAccess: (req: AccessPickerRequest): Promise<AccessPickerResult> =>
      Promise.resolve(
        script.pickAccess !== undefined
          ? script.pickAccess(req)
          : { committed: false, model: { selection: new Map() } },
      ),
    notify: (): void => undefined,
    notice: (request: NoticeRequest): Promise<void> => {
      notices.push(request);
      return Promise.resolve();
    },
    showQr: (): void => undefined,
    status: <T,>(_label: string, task: () => Promise<T>): Promise<T> => task(),
  };
  return { ui, menuRequests, notices };
};

/** Commit the picker with the given bits for exactly the named chat keys. */
const commitChats =
  (bits: AccessBits, keys: readonly string[]) =>
  (req: AccessPickerRequest): AccessPickerResult => {
    const selection = new Map<ChatKey, AccessBits>();
    for (const row of req.initialState.rows) {
      if (row.kind === 'chat' && keys.includes(row.chatKey)) {
        selection.set(row.chatKey, bits);
      }
    }
    return { committed: true, model: { selection } };
  };

/** The hint rendered for a given row value in a recorded menu request. */
const hintOf = (
  req: MenuRequest<string> | undefined,
  value: string,
): string | undefined => req?.options.find((o) => o.value === value)?.hint;

interface Spies {
  readonly applied: EndpointDraft[];
  readonly apply: ReturnType<typeof vi.fn>;
  readonly remove: ReturnType<typeof vi.fn>;
}

const makeSpies = (applyResult: () => boolean = () => true): Spies => {
  const applied: EndpointDraft[] = [];
  const apply = vi.fn((updated: EndpointDraft): Promise<boolean> => {
    applied.push(updated);
    return Promise.resolve(applyResult());
  });
  const remove = vi.fn((): Promise<void> => Promise.resolve());
  return { applied, apply, remove };
};

/** The single endpoint handed to `apply` (guarded so tests never `!`/cast). */
const onlyApplied = (spies: Spies): EndpointDraft => {
  const [first] = spies.applied;
  if (first === undefined) {
    throw new Error('expected exactly one applied endpoint');
  }
  return first;
};

/** Narrow an optional string to a value (guarded so tests never `!`/cast). */
const requireString = (value: string | undefined): string => {
  if (value === undefined) {
    throw new Error('expected a defined string');
  }
  return value;
};

const run = (
  fake: FakeUi,
  spies: Spies,
  endpoint: EndpointDraft,
): Promise<void> => {
  const deps: EndpointHubDeps = {
    ui: fake.ui,
    endpoint,
    chats: CHATS,
    folders: FOLDERS,
    apply: spies.apply as EndpointHubDeps['apply'],
    remove: spies.remove as EndpointHubDeps['remove'],
  };
  return runEndpointHub(deps);
};

// ---------------------------------------------------------------------------
// 1) Name spoke
// ---------------------------------------------------------------------------

describe('endpoint hub — Name spoke', () => {
  it('applies a new name once and re-renders the Name hint', async () => {
    const fake = makeUi({ menu: ['name', 'back'], text: ['alice'] });
    const spies = makeSpies();

    await run(fake, spies, baseEndpoint());

    expect(spies.apply).toHaveBeenCalledTimes(1);
    expect(spies.applied[0]?.name).toBe('alice');
    // The SECOND render shows the applied name in the Name row hint.
    expect(hintOf(fake.menuRequests[1], 'name')).toBe(
      'alice',
    );
  });

  it('does NOT apply when the name is unchanged', async () => {
    const fake = makeUi({ menu: ['name', 'back'], text: ['reader'] });
    const spies = makeSpies();

    await run(fake, spies, baseEndpoint({ name: 'reader' }));

    expect(spies.apply).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2) Access spoke (the permission SSOT)
// ---------------------------------------------------------------------------

describe('endpoint hub — Access spoke', () => {
  it('projects a read-only pick and reflects it in the access hint', async () => {
    const fake = makeUi({
      menu: ['access', 'back'],
      pickAccess: commitChats({ read: true, write: false }, [CHAT_ID]),
    });
    const spies = makeSpies();

    await run(fake, spies, baseEndpoint());

    expect(spies.apply).toHaveBeenCalledTimes(1);
    const updated = onlyApplied(spies);
    expect(updated.chats).toEqual([chatRef(CHAT_ID)]);
    expect(updated.verbs).not.toContain('write');
    expect(accessHint(updated)).toBe('1 chats · 0 folders · read');
    // The SECOND render shows the applied access in the Access row hint.
    expect(hintOf(fake.menuRequests[1], 'access')).toBe(
      '1 chats · 0 folders · read',
    );
  });

  it('projects a read+write pick and reflects it in the access hint', async () => {
    const fake = makeUi({
      menu: ['access', 'back'],
      pickAccess: commitChats({ read: true, write: true }, [CHAT_ID]),
    });
    const spies = makeSpies();

    await run(fake, spies, baseEndpoint());

    const updated = onlyApplied(spies);
    // The picker keeps group verbs read-only and projects write to a per-chat
    // OVERRIDE (security-first); the access hint reflects the granted write.
    expect(updated.chatOverrides.some((o) => o.verbs.includes('send'))).toBe(
      true,
    );
    expect(accessHint(updated)).toBe('1 chats · 0 folders · read+write');
    // The SECOND render shows the applied access in the Access row hint.
    expect(hintOf(fake.menuRequests[1], 'access')).toBe(
      '1 chats · 0 folders · read+write',
    );
  });

  it('does NOT apply when the picker is cancelled', async () => {
    const fake = makeUi({
      menu: ['access', 'back'],
      pickAccess: () => ({ committed: false, model: { selection: new Map() } }),
    });
    const spies = makeSpies();

    await run(fake, spies, baseEndpoint());

    expect(spies.apply).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3) Confirm-writes toggle
// ---------------------------------------------------------------------------

describe('endpoint hub — Confirm-writes spoke', () => {
  // Write is projected to per-chat overrides (group verbs stay read-only), so a
  // send override is what makes confirm-writes relevant.
  const writeEndpoint = (): EndpointDraft =>
    baseEndpoint({
      confirmWrites: true,
      chatOverrides: [{ peer: chatRef(CHAT_ID), verbs: ['read', 'send'] }],
    });

  it('toggles confirmWrites off and re-renders the hint (write endpoint)', async () => {
    const fake = makeUi({ menu: ['confirm', 'back'], confirm: [false] });
    const spies = makeSpies();

    await run(fake, spies, writeEndpoint());

    expect(spies.apply).toHaveBeenCalledTimes(1);
    expect(spies.applied[0]?.confirmWrites).toBe(false);
    expect(hintOf(fake.menuRequests[1], 'confirm')).toBe('off');
  });

  it('HIDES the Confirm-writes row for a read-only endpoint (nothing to confirm)', async () => {
    const roFake = makeUi({ menu: ['back'] });
    await run(roFake, makeSpies(), baseEndpoint()); // read-only
    expect(
      (roFake.menuRequests[0]?.options ?? []).map((o) => o.value),
    ).not.toContain('confirm');

    // ...but a WRITE endpoint DOES show it.
    const rwFake = makeUi({ menu: ['back'] });
    await run(rwFake, makeSpies(), writeEndpoint());
    expect(
      (rwFake.menuRequests[0]?.options ?? []).map((o) => o.value),
    ).toContain('confirm');
  });
});

// ---------------------------------------------------------------------------
// 4) API-key spoke: regenerate-only (hash-only; REAL endpoint-token)
// ---------------------------------------------------------------------------

describe('endpoint hub — API-key spoke', () => {
  it('Regenerate mints a NEW verifying pair and shows it once (never stores it)', async () => {
    const start = baseEndpoint();
    const oldHash = requireString(start.tokenHash);

    const fake = makeUi({
      menu: ['apikey', 'regen', 'back', 'back'],
      confirm: [true],
    });
    const spies = makeSpies();

    await run(fake, spies, start);

    // Regenerate applied a NEW matched pair: hash changed AND still verifies.
    expect(spies.apply).toHaveBeenCalledTimes(1);
    const applied = onlyApplied(spies);
    const newToken = requireString(applied.token);
    const newHash = requireString(applied.tokenHash);
    expect(newHash).not.toBe(oldHash);
    expect(endpointTokenMatches(newToken, newHash)).toBe(true);
    expect(endpointTokenMatches(newToken, oldHash)).toBe(false);

    // The NEW key is shown ONCE (copyable) after regeneration.
    expect(
      fake.notices.some((n) => n.body.some((l) => l.includes(newToken))),
    ).toBe(true);
  });

  it('does NOT regenerate when the confirm is declined', async () => {
    const fake = makeUi({
      menu: ['apikey', 'regen', 'back', 'back'],
      confirm: [false],
    });
    const spies = makeSpies();

    await run(fake, spies, baseEndpoint());

    expect(spies.apply).not.toHaveBeenCalled();
  });

  it('DISPLAYS the key in the menu during the session it was generated', async () => {
    const start = baseEndpoint(); // token held transiently this session
    const token = requireString(start.token);

    const fake = makeUi({ menu: ['apikey', 'back', 'back'] });
    const spies = makeSpies();

    await run(fake, spies, start);

    // The spoke shows the full key (copyable) and the hub row previews it.
    expect(
      fake.notices.some((n) => n.body.some((l) => l.includes(token))),
    ).toBe(true);
    expect(hintOf(fake.menuRequests[0], 'apikey')).toBe(truncateKey(token));
    expect(spies.apply).not.toHaveBeenCalled();
  });

  it('is Regenerate-only for a RELOADED endpoint (no in-memory key, never shown)', async () => {
    const reloaded = baseEndpoint();
    delete reloaded.token; // reloaded from hash-only config: only the hash is known

    const fake = makeUi({ menu: ['apikey', 'back', 'back'] });
    const spies = makeSpies();

    await run(fake, spies, reloaded);

    // Nothing in memory to show: no notice, and the row hint is the static label.
    expect(fake.notices).toHaveLength(0);
    expect(hintOf(fake.menuRequests[0], 'apikey')).toBe(
      'set — Regenerate to replace',
    );
    expect(spies.apply).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 5) Delete / Back / Esc
// ---------------------------------------------------------------------------

describe('endpoint hub — Delete and exits', () => {
  it('removes the endpoint after a confirmed Delete', async () => {
    const fake = makeUi({ menu: ['delete'], confirm: [true] });
    const spies = makeSpies();

    await run(fake, spies, baseEndpoint());

    expect(spies.remove).toHaveBeenCalledTimes(1);
    expect(spies.apply).not.toHaveBeenCalled();
  });

  it('does NOT remove when Delete is declined', async () => {
    const fake = makeUi({ menu: ['delete', 'back'], confirm: [false] });
    const spies = makeSpies();

    await run(fake, spies, baseEndpoint());

    expect(spies.remove).not.toHaveBeenCalled();
  });

  it('Back exits without applying or removing', async () => {
    const fake = makeUi({ menu: ['back'] });
    const spies = makeSpies();

    await run(fake, spies, baseEndpoint());

    expect(spies.apply).not.toHaveBeenCalled();
    expect(spies.remove).not.toHaveBeenCalled();
  });

  it('Esc/← (cancel) exits like Back', async () => {
    const fake = makeUi({ menu: ['__cancel__'] });
    const spies = makeSpies();

    await run(fake, spies, baseEndpoint());

    expect(spies.apply).not.toHaveBeenCalled();
    expect(spies.remove).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 6) Rejected apply keeps the OLD value
// ---------------------------------------------------------------------------

describe('endpoint hub — rejected apply', () => {
  it('keeps the old name when apply returns false (schema rejection)', async () => {
    const fake = makeUi({ menu: ['name', 'back'], text: ['bob'] });
    const spies = makeSpies(() => false); // e.g. a duplicate-name rejection

    await run(fake, spies, baseEndpoint({ name: 'reader' }));

    expect(spies.apply).toHaveBeenCalledTimes(1);
    expect(spies.applied[0]?.name).toBe('bob');
    // The rejection is not adopted: the next render still shows the OLD name.
    expect(hintOf(fake.menuRequests[1], 'name')).toBe(
      'reader',
    );
  });
});

// ---------------------------------------------------------------------------
// uniqueEndpointName — a non-colliding default for first-run creation
// ---------------------------------------------------------------------------

describe('uniqueEndpointName', () => {
  it('returns the base name when it is free', () => {
    expect(uniqueEndpointName([])).toBe('reader');
    expect(uniqueEndpointName(['other'])).toBe('reader');
  });

  it('suffixes -2, -3, … past the taken names (no collision with existing)', () => {
    expect(uniqueEndpointName(['reader'])).toBe('reader-2');
    expect(uniqueEndpointName(['reader', 'reader-2'])).toBe('reader-3');
    expect(uniqueEndpointName(['reader', 'reader-2', 'reader-4'])).toBe('reader-3');
  });

  it('honours a custom base', () => {
    expect(uniqueEndpointName(['bot'], 'bot')).toBe('bot-2');
  });
});
