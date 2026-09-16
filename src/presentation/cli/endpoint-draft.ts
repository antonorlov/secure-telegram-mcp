/**
 * The ergonomic on-disk endpoint model plus the per-field editors shared by the first-run
 * wizard and the random-access edit hub, so their validation and prompts can never drift.
 * Framework-free: no Ink, React or GramJS import, so every editor is unit-testable behind a
 * fake `SetupUi`.
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

/**
 * A plain editable model over the schema's NORMALISED field types, so a re-run round-trips the
 * file losslessly with no shorthand re-coding per edit; serialization lives in
 * FileConfigRepository.
 */
export interface EndpointDraft {
  name: string;
  session: string;
  chats: PeerRef[];
  folders: FolderRef[];
  verbs: PermissionVerb[];
  confirmWrites: boolean;
  chatOverrides: DeclaredChatVerbOverride[];
  // Salted digest of the endpoint API key — persisted, authorization gate only.
  tokenHash: string;
  // Transient, this run only: the config stores just `tokenHash`. Present when the key was
  // minted this session, so it can be shown once and inlined into the exit `.mcp.json` block.
  token?: string;
}

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

// Name, session, HITL and key stay with the other editors.
export type AccessProjection = Readonly<
  Pick<EndpointDraft, 'chats' | 'folders' | 'verbs' | 'chatOverrides'>
>;

const DEFAULT_ENDPOINT_NAME = 'reader';

// `base`, else `base-2`, `base-3`, … The config schema rejects duplicate names, so a fresh
// create must not pre-fill an already-taken slug.
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

// True when an endpoint grants write anywhere — group verbs or any per-chat override. Answers
// whether write confirmation is even relevant: a read-only endpoint has no writes to confirm.
export const grantsWriteVerbs = (access: {
  readonly verbs: readonly PermissionVerb[];
  readonly chatOverrides: readonly { readonly verbs: readonly PermissionVerb[] }[];
}): boolean =>
  access.verbs.some(isWriteVerb) ||
  access.chatOverrides.some((o) => o.verbs.some(isWriteVerb));

// `confirmWrites` is shown only when the endpoint can write; for a read-only endpoint it is
// irrelevant.
export const endpointSummary = (ep: EndpointDraft): string => {
  const base =
    `@${ep.session} · ${ep.verbs.join('/')} · ${String(ep.chats.length)} chats · ` +
    `${String(ep.folders.length)} folders`;
  return grantsWriteVerbs(ep)
    ? `${base} · confirmWrites ${ep.confirmWrites ? 'on' : 'off'}`
    : base;
};

export const accessHint = (ep: EndpointDraft): string =>
  `${String(ep.chats.length)} chats · ${String(ep.folders.length)} folders · ${
    grantsWriteVerbs(ep) ? 'read+write' : 'read'
  }`;

// Only ever called with a token held transiently this session — the config keeps only the hash.
export const truncateKey = (token: string): string => {
  const body = token.startsWith('tgmcp_') ? token.slice('tgmcp_'.length) : token;
  if (body.length <= 7) {
    return token;
  }
  return `tgmcp_${body.slice(0, 3)}…${body.slice(-4)}`;
};

// The slug rule is a recoverable, in-place re-prompt; the schema is the final gate, rejecting a
// collision or malformed slug on save.
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
 * Editing would DROP stored refs that no longer match a live chat or folder, so confirm first.
 * Default is NO, so Esc or Enter keeps the endpoint untouched rather than silently narrowing
 * it.
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
 * Membership and per-chat r/w are chosen in one screen — there is no separate permissions
 * editor. Hydrates the id-keyed selection from `current` for re-entrancy, then projects the
 * committed model back onto the draft. Returns `undefined` on cancel, empty scope or zero
 * verbs.
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

  /**
   * Stored refs the live account no longer has cannot be pre-checked and would drop silently on
   * commit. Surface them for an explicit decision before the picker opens — declining keeps the
   * endpoint untouched.
   */
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

// Token and hash derive from one `mintEndpointToken()` so they can never drift. The plaintext
// is transient; only the salted hash is persisted.
export const mintEndpointKey = (): { token: string; tokenHash: string } => {
  const token = mintEndpointToken();
  return { token, tokenHash: hashEndpointToken(token) };
};

// One definition shared by the create wizard and the hub's key spoke, so the copy and the
// env-var name never drift.
export const apiKeyNotice = (name: string, token: string): NoticeRequest => ({
  title: `API key for "${name}" (shown once)`,
  body: [
    `  ${token}`,
    `Copy this into your MCP client config (${ENDPOINT_TOKEN_ENV}).`,
    'Visible only this session — not stored; it also appears in the exit config block.',
  ],
});
