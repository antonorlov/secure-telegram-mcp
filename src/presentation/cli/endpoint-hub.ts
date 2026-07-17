/**
 * Endpoint edit hub — the hub-and-spoke controller for editing one existing endpoint. A
 * single menu that gives random access to each field, each row showing the current value via
 * its `hint` (the linear wizard stays only for first-run creation).
 *
 * Save model = immediate commit: every completed spoke persists and publishes through
 * the injected `apply`/`remove` callbacks before the hub re-renders with the new value.
 * `apply` returns `false` when the change was rejected (e.g. a rename that collides — caught
 * by the config schema's uniqueness rule); the hub then keeps the old value, so it can never
 * display an unsaved/invalid state.
 *
 * This controller depends only on the framework-free `SetupUi` port, the `EndpointDraft`
 * DTO, the shared field editors, and `MenuOption`. Persistence is entirely behind
 * `apply`/`remove` (the flow in setup.ts owns that commit transaction).
 */
import type {
  AccountChatDto,
  AccountFolderDto,
} from '../../application/index.js';
import type { MenuOption } from './ink/ui-port.js';
import type { SetupUi } from './ink/setup-ui-port.js';
import {
  accessHint,
  apiKeyNotice,
  endpointSummary,
  grantsWriteVerbs,
  mintEndpointKey,
  promptConfirmWrites,
  promptEndpointName,
  runAccessEditor,
  truncateKey,
  type EndpointDraft,
} from './endpoint-draft.js';

export interface EndpointHubDeps {
  readonly ui: SetupUi;
  /** The starting value of the selected endpoint. */
  readonly endpoint: EndpointDraft;
  readonly chats: readonly AccountChatDto[];
  readonly folders: readonly AccountFolderDto[];
  /**
   * Persist and publish the whole updated endpoint. Returns `false` when the draft
   * write was rejected (schema-invalid, e.g. a duplicate name); the hub then keeps
   * the previous value.
   */
  readonly apply: (updated: EndpointDraft) => Promise<boolean>;
  /** Persist and publish deletion of this endpoint, then exit the hub. */
  readonly remove: () => Promise<void>;
}

/**
 * The API-key spoke (hash-only config): the plaintext is never persisted (config keeps only
 * the salted hash). But a key minted this session is still held in memory (`cur.token`), so
 * we can show it here — a copyable preview. A reloaded endpoint has only the hash, so it is
 * regenerate-only. Regenerate is destructive (old key stops working), gated by a confirm; on
 * confirm it mints a fresh matched pair, re-applies (autosaves the new hash), and the loop
 * re-renders showing the new key. The key also rides out in the exit `.mcp.json` block.
 */
const runApiKeySpoke = async (
  ui: SetupUi,
  current: EndpointDraft,
  apply: (updated: EndpointDraft) => Promise<boolean>,
): Promise<EndpointDraft> => {
  let cur = current;
  for (;;) {
    // Show the full key only when it is held in memory this session (never stored).
    if (cur.token !== undefined) {
      await ui.notice(apiKeyNotice(cur.name, cur.token));
    }
    const res = await ui.menu<'regen' | 'back'>({
      title: `API key for "${cur.name}"`,
      subtitle:
        cur.token !== undefined
          ? truncateKey(cur.token)
          : 'shown once at creation; not stored — Regenerate to replace',
      options: [
        {
          value: 'regen',
          label: 'Regenerate API key',
          hint: 'mint a new key; the old one stops working',
        },
        { value: 'back', label: 'Back', hint: 'return to the endpoint menu' },
      ],
    });
    const choice = res.kind === 'selected' ? res.value : 'back';
    if (choice === 'back') {
      return cur;
    }
    const confirmed = await ui.confirm({
      title:
        'Regenerate the API key? Existing clients using the old key will stop working.',
      defaultValue: false,
    });
    if (confirmed.kind === 'submitted' && confirmed.value) {
      const updated = { ...cur, ...mintEndpointKey() };
      if (await apply(updated)) {
        cur = updated; // now in memory -> the loop's top notice shows the new key
      }
    }
  }
};

/**
 * Drive the edit hub for one endpoint until the operator picks Back (or Esc/←,
 * which maps to Back, consistent with every other menu) or deletes it.
 */
export const runEndpointHub = async (deps: EndpointHubDeps): Promise<void> => {
  const { ui } = deps;
  let current = deps.endpoint;
  type HubChoice = 'name' | 'access' | 'confirm' | 'apikey' | 'delete' | 'back';
  for (;;) {
    const options: MenuOption<HubChoice>[] = [
      { value: 'name', label: 'Name', hint: current.name },
      {
        value: 'access',
        label: 'Access — chats & folders',
        hint: accessHint(current),
      },
      // Confirm-writes only matters when the endpoint can write — hidden otherwise.
      ...(grantsWriteVerbs(current)
        ? [
            {
              value: 'confirm',
              label: 'Confirm writes (HITL)',
              hint: current.confirmWrites ? 'on' : 'off',
            } as MenuOption<HubChoice>,
          ]
        : []),
      {
        value: 'apikey',
        label: 'API key',
        // A key minted this session is in memory (preview it); a reloaded one is not.
        hint:
          current.token !== undefined
            ? truncateKey(current.token)
            : 'set — Regenerate to replace',
      },
      {
        value: 'delete',
        label: 'Delete endpoint (danger)',
        hint: 'remove this endpoint',
      },
      { value: 'back', label: 'Back', hint: 'return to the endpoints list' },
    ];
    const res = await ui.menu<HubChoice>({
      title: `Endpoint "${current.name}"`,
      subtitle: endpointSummary(current),
      options,
    });
    // Esc/← (cancel) == Back, consistent with the other menus.
    const choice = res.kind === 'selected' ? res.value : 'back';
    switch (choice) {
      case 'name': {
        const name = await promptEndpointName(ui, current.name);
        if (name !== current.name) {
          const updated = { ...current, name };
          if (await deps.apply(updated)) {
            current = updated;
          }
        }
        break;
      }
      case 'access': {
        const proj = await runAccessEditor(
          ui,
          current.name,
          current,
          deps.chats,
          deps.folders,
        );
        if (proj !== undefined) {
          const updated = { ...current, ...proj };
          if (await deps.apply(updated)) {
            current = updated;
          }
        }
        break;
      }
      case 'confirm': {
        const confirmWrites = await promptConfirmWrites(ui, current.confirmWrites);
        if (confirmWrites !== current.confirmWrites) {
          const updated = { ...current, confirmWrites };
          if (await deps.apply(updated)) {
            current = updated;
          }
        }
        break;
      }
      case 'apikey':
        current = await runApiKeySpoke(ui, current, deps.apply);
        break;
      case 'delete': {
        const confirmed = await ui.confirm({
          title: `Delete endpoint "${current.name}"? This cannot be undone.`,
          defaultValue: false,
        });
        if (confirmed.kind === 'submitted' && confirmed.value) {
          await deps.remove();
          return;
        }
        break;
      }
      case 'back':
        return;
    }
  }
};
