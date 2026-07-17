/**
 * Endpoint draft + shared field editors — the ergonomic on-disk endpoint model and the
 * per-field editing primitives reused by both the first-run creation wizard
 * (`editEndpoint`) and the random-access edit hub (`runEndpointHub`). The wizard and the
 * hub call the same name / access / confirm-writes / API-key editors, so their validation
 * and prompts can never drift.
 *
 * Framework-free: depends only on the `SetupUi` port, the framework-free picker model +
 * bridge, the config value types, the domain verb vocabulary, and the infrastructure token
 * mint/hash. No Ink/React/GramJS import, so every editor is unit-testable behind a fake `SetupUi`.
 */
import {
  ENDPOINT_TOKEN_ENV,
  hashEndpointToken,
  mintEndpointToken,
} from '../../infrastructure/endpoint-token.js';
import type {
  AccountChatDto,
  AccountFolderDto,
} from '../../application/index.js';
import type { ValidatedEndpoint } from '../../config/index.js';
import {
  PermissionVerb,
  isSlug,
  isWriteVerb,
  type DeclaredChatVerbOverride,
  type FolderRef,
  type PeerRef,
} from '../../domain/index.js';
import { buildPickerTree } from './picker-bridge.js';
import {
  createPickerState,
  hydratePickerSelection,
  projectPickerSelection,
  unmatchedPickerRefs,
} from './picker/index.js';
import type { NoticeRequest, SetupUi } from './ink/setup-ui-port.js';

// The draft DTO — a plain editable model over the schema's NORMALISED field types
// (PeerRef/FolderRef/verbs), so a re-run round-trips the file losslessly with no
// shorthand<->entry re-coding per edit; serialization lives in FileConfigRepository.

export interface EndpointDraft {
  name: string;
  session: string;
  chats: PeerRef[];
  folders: FolderRef[];
  verbs: PermissionVerb[];
  confirmWrites: boolean;
  /** Per-chat verb overrides (the picker's r/w projected onto verb tiers). */
  chatOverrides: DeclaredChatVerbOverride[];
  /** Salted digest of the endpoint API key (persisted; authorization gate only). */
  tokenHash: string;
  /**
   * The plaintext API key — transient (this run only; never persisted — the config stores
   * only `tokenHash`). Present when the key was just minted this session (create /
   * regenerate), so it can be shown once and inlined into the exit `.mcp.json` block; a
   * reloaded endpoint carries only the hash.
   */
  token?: string;
}

/** Project the schema's normalised endpoint DTO into the mutable setup draft. */
export const endpointDraftFromValidated = (
  endpoint: ValidatedEndpoint,
): EndpointDraft => ({
  name: endpoint.name,
  session: endpoint.session,
  chats: [...endpoint.scope.chats],
  folders: [...endpoint.scope.folders],
  verbs: [...endpoint.verbs],
  confirmWrites: endpoint.hitl.confirmWrites,
  chatOverrides: [...endpoint.scope.chatOverrides],
  tokenHash: endpoint.tokenHash,
});

/**
 * The membership + access fragment the access editor projects out of the picker.
 * Merged into an `EndpointDraft` by both the wizard and the hub (name / session /
 * HITL / key are owned by the other editors).
 */
export interface AccessProjection {
  readonly chats: PeerRef[];
  readonly folders: FolderRef[];
  readonly verbs: PermissionVerb[];
  readonly chatOverrides: DeclaredChatVerbOverride[];
}

/** The default endpoint name offered on a first-run create. */
const DEFAULT_ENDPOINT_NAME = 'reader';

/**
 * A default endpoint name that does NOT collide with existing ones: `base`, else
 * `base-2`, `base-3`, … The config schema rejects duplicate names, so a fresh
 * create must not pre-fill an already-taken slug.
 */
export const uniqueEndpointName = (
  existing: readonly string[],
  base: string = DEFAULT_ENDPOINT_NAME,
): string => {
  const taken = new Set(existing);
  if (!taken.has(base)) return base;
  for (let i = 2; ; i += 1) {
    const candidate = `${base}-${String(i)}`;
    if (!taken.has(candidate)) return candidate;
  }
};

// Read-only projections of a draft (row hints + summaries)

/**
 * True when an endpoint (or a fresh access projection) grants write anywhere — its group
 * verbs or any per-chat override (the picker projects write to overrides, keeping group
 * verbs read-only, security-first). Answers "is write confirmation even relevant?" — a
 * read-only endpoint has no writes to confirm.
 */
export const grantsWriteVerbs = (access: {
  readonly verbs: readonly PermissionVerb[];
  readonly chatOverrides: readonly { readonly verbs: readonly PermissionVerb[] }[];
}): boolean =>
  access.verbs.some(isWriteVerb) ||
  access.chatOverrides.some((o) => o.verbs.some(isWriteVerb));

/**
 * One-line summary of an endpoint (row hint / hub subtitle). `confirmWrites` is shown only
 * when the endpoint can write — for a read-only endpoint it is irrelevant, so it is omitted.
 */
export const endpointSummary = (ep: EndpointDraft): string => {
  const base =
    `@${ep.session} · ${ep.verbs.join('/')} · ${String(ep.chats.length)} chats · ` +
    `${String(ep.folders.length)} folders`;
  return grantsWriteVerbs(ep)
    ? `${base} · confirmWrites ${ep.confirmWrites ? 'on' : 'off'}`
    : base;
};

/** The Access row hint: "N chats · M folders · <read|read+write>". */
export const accessHint = (ep: EndpointDraft): string =>
  `${String(ep.chats.length)} chats · ${String(ep.folders.length)} folders · ${
    grantsWriteVerbs(ep) ? 'read+write' : 'read'
  }`;

/**
 * A short preview of an API key for the hub row hint, e.g. `tgmcp_abc…wxyz` (prefix + first
 * 3 body chars + `…` + last 4). Only ever called with a token held transiently this session
 * (never a stored one — the config keeps only the hash).
 */
export const truncateKey = (token: string): string => {
  const body = token.startsWith('tgmcp_') ? token.slice('tgmcp_'.length) : token;
  if (body.length <= 7) {
    return token;
  }
  return `tgmcp_${body.slice(0, 3)}…${body.slice(-4)}`;
};

// Shared per-field editors (reused by the creation wizard and the edit hub)

/**
 * Prompt for the endpoint name (lowercase slug). The pre-filled value is the current name
 * (or `reader` on create); an empty submit or cancel keeps it. The slug rule is a
 * recoverable, in-place re-prompt (the schema is the final gate — a collision or malformed
 * slug is rejected there on save).
 */
export const promptEndpointName = async (
  ui: SetupUi,
  defaultName: string,
): Promise<string> => {
  const result = await ui.text({
    title: 'Endpoint name (lowercase slug)',
    defaultValue: defaultName,
    validate: (value) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        return undefined; // empty -> accept, resolves to the pre-filled default
      }
      return isSlug(trimmed)
        ? undefined
        : 'Use a lowercase slug: a–z, 0–9, _ or - (1–64 chars, start alphanumeric).';
    },
  });
  if (result.kind !== 'submitted') {
    return defaultName;
  }
  const trimmed = result.value.trim();
  return trimmed.length > 0 ? trimmed : defaultName;
};

/**
 * Warn that stored scope refs no longer match any live chat/folder (a rename or
 * departure) and confirm proceeding — editing would DROP them. Default is NO, so
 * an Esc/Enter keeps the endpoint untouched rather than silently narrowing it.
 */
const promptUnmatchedRefs = async (
  ui: SetupUi,
  items: readonly string[],
): Promise<boolean> => {
  const result = await ui.confirm({
    title: 'Some saved scope entries no longer match this account — continue editing?',
    subtitle:
      'Editing this endpoint will DROP the entries below (a chat left, or a folder/username was renamed).',
    help: [
      ...items.map((i) => `  • ${i}`),
      'Choose No to keep the endpoint unchanged; fix the reference, then re-edit.',
    ],
    defaultValue: false,
  });
  return result.kind === 'submitted' ? result.value : false;
};

/**
 * The hard step: the pruned-tree access picker -> review gate (`ui.pickAccess`), where both
 * membership (which chats/folders are in scope) and per-chat r/w are chosen — there is no
 * separate permissions editor. Hydrates the id-keyed selection from `current`
 * (re-entrancy), then projects the committed model back to the draft's
 * `chats/folders/verbs/chatOverrides`. Returns `undefined` (already `notify`-ing) on
 * cancel, empty scope, or zero verbs.
 */
export const runAccessEditor = async (
  ui: SetupUi,
  endpointName: string,
  current: EndpointDraft | undefined,
  chats: readonly AccountChatDto[],
  folders: readonly AccountFolderDto[],
): Promise<AccessProjection | undefined> => {
  const { rows, enumeration } = buildPickerTree(chats, folders);
  const groupVerbs = current?.verbs ?? [PermissionVerb.Read];
  // The draft already holds the schema's normalised scope types — no re-coding.
  const scope = {
    chats: current?.chats ?? [],
    folders: current?.folders ?? [],
    chatOverrides: current?.chatOverrides ?? [],
  };

  // Stored refs the live account no longer has (a chat left, a folder/username
  // renamed) can't be pre-checked and would DROP silently on commit. Surface
  // them for an explicit decision before the picker opens — declining keeps the
  // endpoint untouched rather than quietly narrowing its scope.
  const unmatched = unmatchedPickerRefs(scope, enumeration);
  if (unmatched.chats.length > 0 || unmatched.folders.length > 0) {
    const items = [...unmatched.folders.map((f) => `folder ${f}`), ...unmatched.chats];
    const proceed = await promptUnmatchedRefs(ui, items);
    if (!proceed) {
      ui.notify('Access edit cancelled; endpoint not changed.');
      return undefined;
    }
  }

  const initial = hydratePickerSelection({ groupVerbs, scope, enumeration });
  const initialState = createPickerState({
    endpointName,
    rows,
    selection: initial.selection,
    folderScope: initial.folderScope ?? new Set<string>(),
  });

  const result = await ui.pickAccess({ initialState });
  if (!result.committed) {
    ui.notify('Access edit cancelled; endpoint not changed.');
    return undefined;
  }

  const projected = projectPickerSelection(result.model, enumeration);
  if (projected.chats.length === 0 && projected.folders.length === 0) {
    ui.notify('No chats or folders were selected; aborting this endpoint.');
    return undefined;
  }
  if (projected.groupVerbs.length === 0) {
    ui.notify('An endpoint must grant at least read; aborting this endpoint.');
    return undefined;
  }

  return {
    chats: [...projected.chats],
    folders: [...projected.folders],
    verbs: [...projected.groupVerbs],
    chatOverrides: [...projected.chatOverrides],
  };
};

/** Ask whether writes require human confirmation (HITL); keeps the current value on cancel. */
export const promptConfirmWrites = async (
  ui: SetupUi,
  current: boolean,
): Promise<boolean> => {
  const result = await ui.confirm({
    title: 'Require human confirmation for writes?',
    defaultValue: current,
  });
  return result.kind === 'submitted' ? result.value : current;
};

/**
 * Mint a fresh endpoint API key as a matched pair `{ token, tokenHash }` from the same
 * token. The plaintext `token` is transient (shown once + inlined into the exit config);
 * only the salted `tokenHash` is persisted (the auth gate). Both derive from one
 * `mintEndpointToken()` so they can never drift.
 */
export const mintEndpointKey = (): { token: string; tokenHash: string } => {
  const token = mintEndpointToken();
  return { token, tokenHash: hashEndpointToken(token) };
};

/**
 * The shown-once API-key notice: the copyable plaintext key, where to paste it, and the
 * honest "not stored" caveat. One definition shared by the create wizard and the edit hub's
 * key spoke, so the copy + env-var name never drift. The plaintext is only held transiently.
 */
export const apiKeyNotice = (name: string, token: string): NoticeRequest => ({
  title: `API key for "${name}" (shown once)`,
  body: [
    `  ${token}`,
    `Copy this into your MCP client config (${ENDPOINT_TOKEN_ENV}).`,
    'Visible only this session — not stored; it also appears in the exit config block.',
  ],
});
