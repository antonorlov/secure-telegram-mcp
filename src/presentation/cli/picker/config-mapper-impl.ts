/**
 * Config <-> picker mapper — the lossless projection editor over the Zod config:
 * the enumeration DTOs plus the pure projection functions (`hydratePickerSelection`
 * / `projectPickerSelection` / `unmatchedPickerRefs`) and the bit<->verb
 * translation (`bitsToVerbs` / `verbsToBits`). Framework-free: no
 * Ink/React/node:*; depends only on the config types, the domain verb vocabulary, and
 * the picker model.
 *
 * THE 2-BIT PROJECTION. The picker edits access as two independent bits (read /
 * write — the chmod model); the config stores the full least-privilege verb
 * vocabulary. The translation is a deliberate TIER projection:
 *  - verbs -> bits: read = the set contains any read-tier verb; write = it contains
 *    any write-tier verb (`isReadVerb`/`isWriteVerb`).
 *  - bits -> verbs: each bit expands to its FULL tier — read -> {read,
 *    read_media}, write -> {send, draft, delete, mark_read, forward, react} ("r means
 *    read, w means write", filesystem semantics). Hand-authored narrower sets (a
 *    text-only `[read]` or a `[read, mark_read]`) COLLAPSE to the tier
 *    on a picker edit — the 2-bit model trades verb granularity for a read/write
 *    toggle, so a hand-stripping is lost the moment a chat is edited in the picker.
 *    Round-trip is membership- and tier-stable (a member stays a member, read-only
 *    stays read-only, writable stays writable), not verb-identical for hand-authored
 *    sets. Chat-ref FORM normalizes on commit: 'me' and numeric ids re-emit as-is; a
 *    hand-authored '@username' matches its enumerated chat (by username) and re-emits
 *    in the canonical numeric-id form — membership survives, the spelling does not.
 *
 * SECURITY: projection only ever shapes access within the membership the operator
 * picked. A chat is a member iff it is selected (serialized directly or covered by
 * an explicit folder member); an override only emits for a member. Default-deny is
 * preserved (absent selection entry = non-member = no access).
 */
import { chatEntryToRef, type ValidatedScope } from '../../../config/index.js';
import {
  ALL_PERMISSION_VERBS,
  isReadVerb,
  isWriteVerb,
  type DeclaredChatVerbOverride,
  type FolderRef,
  type PeerRef,
  type PermissionVerb as Verb,
} from '../../../domain/index.js';
import type {
  AccessBits,
  ChatKey,
  FolderKey,
  PickerSelectionModel,
} from './model.js';

// Contract — the enumeration DTOs. These pin the lossless round-trip (re-running
// setup hydrates the same selection; re-saving an untouched endpoint reproduces the
// same membership + access tier per chat); projection only ever shapes access
// within the declared scope.

/**
 * One chat from the daemon account snapshot, paired with the folders it appears
 * under. The mapper needs this to bridge the config's chat references ('me' / '@user'
 * / id) to the picker's canonical `ChatKey`, and to know which folder rows a chat
 * belongs to (cross-folder dedup).
 */
export interface PickerChatSource {
  readonly chatKey: ChatKey;
  /** The canonical config ref this chat re-serialises to (numeric id; 'me' for self). */
  readonly ref: PeerRef;
  readonly title: string;
  readonly username?: string;
}

/** An enumerated folder + the keys of the chats resolved to be inside it. */
export interface PickerFolderSource {
  /** The folder's numeric id — what the `FolderKey`/config ref project from. */
  readonly id: number;
  readonly title: string;
  readonly childChatKeys: readonly ChatKey[];
  /**
   * The EXPLICIT (pinned ∪ included) member keys — the ONLY ones the runtime
   * resolver tracks for a `folders[]` ref. Rule-matched (category-flag) members
   * are snapshotted as individual chats, never covered by the folder unit.
   * Defaults to `childChatKeys` when omitted (a flag-free folder).
   */
  readonly explicitChatKeys?: readonly ChatKey[];
}

/** The live account enumeration the projection is computed against. */
export interface PickerEnumeration {
  readonly chats: readonly PickerChatSource[];
  readonly folders: readonly PickerFolderSource[];
}

/** Hydration input: an existing endpoint scope + the live enumeration. */
export interface HydrateInput {
  /**
   * The endpoint's group-level verbs. Hydration resolves them into explicit per-chat
   * bits (membership IS access — no inherit layer in the picker): a member without a
   * `chatOverride` gets these bits made explicit.
   */
  readonly groupVerbs: readonly Verb[];
  /** The existing declared scope (chats/folders + chatOverrides) to pre-check. */
  readonly scope: ValidatedScope;
  readonly enumeration: PickerEnumeration;
}

/**
 * The projection back onto config: the membership + override portion of a scope the
 * wizard merges into the endpoint draft. Folders picked as a scope unit project to
 * `folders[]`; their explicit member chats are de-duplicated, while rule-matched
 * members are emitted as stable `chats[]` snapshots.
 */
export interface ProjectedScope {
  /**
   * Member chats picked individually (not covered by a scope-unit folder), as config
   * refs in the canonical enumerated form (numeric id; 'me' for self). A hand-authored
   * '@username' member re-emits as its id — membership preserved, form normalized.
   */
  readonly chats: readonly PeerRef[];
  /** Folders with selected explicit members, as config refs (canonical id form). */
  readonly folders: readonly FolderRef[];
  /** Per-chat overrides for chats whose rule is an explicit `override`. */
  readonly chatOverrides: readonly DeclaredChatVerbOverride[];
  /** The group-level verbs derived from the group-default bits. */
  readonly groupVerbs: readonly Verb[];
}

/**
 * Configured scope refs that no live-enumerated chat/folder matches — a chat that
 * left, or a folder/username renamed since the config was written. Hydration
 * cannot pre-check them and a commit would DROP them silently, so the access
 * editor surfaces these for explicit confirmation before an edit.
 */
export interface UnmatchedRefs {
  /** Stored `chats`/`chatOverrides` refs with no enumerated chat, deduplicated. */
  readonly chats: readonly string[];
  /** Stored `folders` refs (id or title, as text) with no enumerated folder. */
  readonly folders: readonly string[];
}

// Bit <-> verb translation (how r/w map onto the verb vocabulary)

/**
 * The full READ tier a read-bit expands to. `read` is passive history +
 * metadata; `read_media` is the media-egress opt-in that rides inside a read grant
 * (separately strippable by a hand-authored verb list / override / kill-switch, never
 * by the picker). DERIVED from the domain verb vocabulary — never restated by hand —
 * so a new verb cannot drift between detection (`verbsToBits`) and projection
 * (`bitsToVerbs`).
 */
const READ_TIER_VERBS: readonly Verb[] = Object.freeze(
  ALL_PERMISSION_VERBS.filter(isReadVerb),
);
/**
 * The full WRITE tier a write-bit expands to ("w means write"). Derived like the
 * read tier.
 */
const WRITE_TIER_VERBS: readonly Verb[] = Object.freeze(
  ALL_PERMISSION_VERBS.filter(isWriteVerb),
);
/**
 * The canonical group-level default the projection emits: read-only (security-first).
 * Members with exactly these bits ride on it; anything else (rw / w-only) emits an
 * explicit per-chat override.
 */
const GROUP_DEFAULT_BITS: AccessBits = Object.freeze({ read: true, write: false });

/**
 * The verbs a set of bits grants: each set bit expands to its FULL tier —
 * the ONE place the picker's r/w maps onto the verb vocabulary.
 */
export const bitsToVerbs = (bits: AccessBits): readonly Verb[] => {
  const verbs: Verb[] = [];
  if (bits.read) verbs.push(...READ_TIER_VERBS);
  if (bits.write) verbs.push(...WRITE_TIER_VERBS);
  return verbs;
};

/**
 * The bits implied by a verb set (presence of any read/write tier verb, via the
 * domain tier predicates) — so a hand-configured chat still shows the right r/w
 * bits (read_media -> read, react + mark_read -> write).
 */
export const verbsToBits = (verbs: readonly Verb[]): AccessBits => ({
  read: verbs.some(isReadVerb),
  write: verbs.some(isWriteVerb),
});

// Chat-ref identity — bridge the config `PeerRef` to the picker `ChatKey`

/**
 * A canonical, comparable key for a config chat reference. Usernames are folded to
 * lower case (Telegram usernames are case-insensitive); numeric ids use `ChatId`'s
 * canonical decimal key. This lets a `scope.chats` entry and a `chatOverrides` key
 * line up with the live enumeration's ref by identity.
 */
const refIdentity = (entry: PeerRef): string => {
  switch (entry.kind) {
    case 'me':
      return 'me';
    case 'id':
      return `id:${entry.id.toKey()}`;
    case 'username':
      return `user:${entry.username.toLowerCase()}`;
  }
};

/**
 * Does a folderScope mark actually COMMIT as a `folders[]` scope-unit ref?
 *
 * The ref covers exactly the folder's EXPLICIT (pinned ∪ included) members — the
 * only ones the runtime resolver tracks. So it commits as a unit only while:
 *  - the folder is marked, AND
 *  - every EXPLICIT member is still selected (an unselected explicit child
 *    demotes it back to individual chats — self-correcting), AND
 *  - it has at least one explicit member, UNLESS its live membership is
 *    unenumerated (`childChatKeys` empty), in which case a config-authored ref
 *    is preserved vacuously (round-trip). A folder with rule members but NO
 *    explicit members would resolve to ZERO peers at runtime, so it never
 *    commits as a unit — its rule matches snapshot as individual chats instead.
 *
 * The ONE predicate shared by the projection and the review screen, so the
 * review never describes a folder unit the commit would drop (or vice versa).
 */
export const isCommittedFolderUnit = (
  model: PickerSelectionModel,
  folderKey: FolderKey,
  explicitChatKeys: readonly ChatKey[],
  childChatKeys: readonly ChatKey[],
): boolean =>
  (model.folderScope?.has(folderKey) ?? false) &&
  explicitChatKeys.every((key) => model.selection.has(key)) &&
  (explicitChatKeys.length > 0 || childChatKeys.length === 0);

// Shared ref->key matching — the ONE definition of "does a config ref match a
// live-enumerated chat/folder", used by BOTH hydrate (to pre-check) and
// unmatchedRefs (to report what hydrate skips), so they can never disagree.

/**
 * ref-identity -> chatKey. Each enumerated chat registers BOTH its canonical ref
 * (numeric id / 'me') and, when it has a username, the '@username' identity — a
 * hand-authored '@user' scope entry must land on the same enumerated chat instead
 * of silently hydrating unchecked (and then being dropped on commit).
 */
const buildChatKeyByRef = (
  enumeration: PickerEnumeration,
): ReadonlyMap<string, ChatKey> => {
  const keyByRef = new Map<string, ChatKey>();
  for (const source of enumeration.chats) {
    keyByRef.set(refIdentity(source.ref), source.chatKey);
    if (source.username !== undefined) {
      keyByRef.set(
        refIdentity({ kind: 'username', username: source.username }),
        source.chatKey,
      );
    }
  }
  return keyByRef;
};

/** The enumerated folder a `folders[]` ref matches (id-exact or title-exact), or undefined. */
const matchFolderRef = (
  ref: FolderRef,
  enumeration: PickerEnumeration,
): PickerFolderSource | undefined =>
  enumeration.folders.find((folder) =>
    ref.kind === 'id' ? folder.id === ref.id : folder.title === ref.title,
  );

/** Render a stored folder ref to its human text (for the unmatched-refs notice). */
const folderRefText = (ref: FolderRef): string =>
  ref.kind === 'id' ? `#${String(ref.id)}` : ref.title;

// The projection functions — the one pure implementation, exported as plain
// module functions (stateless; no class/singleton ceremony).

/**
 * Build the picker's initial id-keyed selection from an existing endpoint scope and
 * the live enumeration. Members come from `scope.chats`, each with explicit bits
 * (membership IS access — no inherit layer): the `chatOverride` bits when declared,
 * else the endpoint `groupVerbs` resolved to bits. A new endpoint (empty scope)
 * yields an empty selection (default-deny).
 */
export const hydratePickerSelection = (
  input: HydrateInput,
): PickerSelectionModel => {
  const { scope, groupVerbs, enumeration } = input;
  const groupBits = verbsToBits(groupVerbs);

  const keyByRef = buildChatKeyByRef(enumeration);

  // Pre-resolve the per-chat override bits by chatKey (last write wins; the
  // config record cannot hold duplicate keys, so there is at most one).
  const overrideBits = new Map<ChatKey, AccessBits>();
  for (const ov of scope.chatOverrides) {
    const chatKey = keyByRef.get(refIdentity(ov.peer));
    if (chatKey !== undefined) {
      overrideBits.set(chatKey, verbsToBits(ov.verbs));
    }
  }

  // A member's explicit bits: its declared override, else the group verbs.
  const bitsFor = (chatKey: ChatKey): AccessBits =>
    overrideBits.get(chatKey) ?? groupBits;

  const selection = new Map<ChatKey, AccessBits>();
  for (const chat of scope.chats) {
    const chatKey = keyByRef.get(refIdentity(chat));
    if (chatKey === undefined) continue; // ref not enumerated (stale) — skip.
    selection.set(chatKey, bitsFor(chatKey));
  }

  // Folder-as-scope-unit pre-check: a declared `folders[]` ref pre-marks that folder
  // as a scope unit and pre-checks its EXPLICIT (pinned ∪ included) members — the
  // set the runtime ref actually tracks — so the picker shows what will really be
  // scoped and the ref round-trips faithfully. Rule-matched members are NOT
  // pre-checked here; any that were snapshotted come back through `scope.chats`
  // above (as individual chats), keeping the round-trip stable.
  const folderScope = new Set<FolderKey>();
  for (const ref of scope.folders) {
    const folder = matchFolderRef(ref, enumeration);
    if (folder === undefined) continue; // ref not enumerated (stale) — skip.
    folderScope.add(String(folder.id));
    for (const chatKey of folder.explicitChatKeys ?? folder.childChatKeys) {
      if (!selection.has(chatKey)) selection.set(chatKey, bitsFor(chatKey));
    }
  }

  return { selection, folderScope };
};

/**
 * The stored refs no live enumeration matches (uses the SAME matching as
 * `hydratePickerSelection`), so the access editor can surface a rename/departure
 * before an edit silently drops it.
 */
export const unmatchedPickerRefs = (
  scope: ValidatedScope,
  enumeration: PickerEnumeration,
): UnmatchedRefs => {
  const keyByRef = buildChatKeyByRef(enumeration);
  const chats = new Map<string, string>();
  for (const chat of [
    ...scope.chats,
    ...scope.chatOverrides.map((override) => override.peer),
  ]) {
    const identity = refIdentity(chat);
    if (keyByRef.get(identity) === undefined && !chats.has(identity)) {
      chats.set(identity, chatEntryToRef(chat));
    }
  }
  const folders = scope.folders
    .filter((ref) => matchFolderRef(ref, enumeration) === undefined)
    .map(folderRefText);
  return { chats: [...chats.values()], folders };
};

/**
 * Project the edited selection back onto config scope fragments — the inverse of
 * `hydratePickerSelection` at the membership/tier level (round-trip stable).
 * Members emit a `chats` ref in the canonical enumerated form (id / 'me'); the
 * emitted `groupVerbs` are the canonical read-only default, and any member whose
 * explicit bits differ from read-only emits a `chatOverride` carrying its verbs.
 */
export const projectPickerSelection = (
  model: PickerSelectionModel,
  enumeration: PickerEnumeration,
): ProjectedScope => {
  // 1. Folders picked as a scope unit: emit as `folders[]` (canonical id form) only
  //    while {@link isCommittedFolderUnit} holds — the SAME predicate the review
  //    screen renders from, so what is reviewed is what commits. (`folderScope`
  //    can only hold an EMPTY folder via hydration: the reducer's
  //    `setFolderAccess` no-ops there, so the picker can never CREATE a ref that
  //    would silently widen the ACL once the folder gains chats.) Member chats
  //    are marked covered so they are not double-emitted.
  const folders: FolderRef[] = [];
  const covered = new Set<ChatKey>();
  const snapshots = new Set<ChatKey>();
  for (const folder of enumeration.folders) {
    const explicit = folder.explicitChatKeys ?? folder.childChatKeys;
    if (model.folderScope?.has(String(folder.id)) ?? false) {
      const explicitSet = new Set(explicit);
      for (const key of folder.childChatKeys) {
        if (!explicitSet.has(key) && model.selection.has(key)) snapshots.add(key);
      }
    }
    if (
      !isCommittedFolderUnit(model, String(folder.id), explicit, folder.childChatKeys)
    ) {
      continue;
    }
    folders.push({ kind: 'id', id: folder.id });
    // Only the EXPLICIT members are covered by the ref; a selected rule-matched
    // member falls through to an individual `chats[]` entry (the snapshot).
    for (const key of explicit) covered.add(key);
  }

  // 2. Individually-picked member chats (those not covered by a scope folder) emit a
  //    `chats` ref; any member whose bits differ from the read-only default emits an
  //    override (overrides ride alongside folder scope).
  const chats: PeerRef[] = [];
  const chatOverrides: DeclaredChatVerbOverride[] = [];
  for (const source of enumeration.chats) {
    const bits = model.selection.get(source.chatKey);
    if (bits === undefined) continue;
    if (!covered.has(source.chatKey) || snapshots.has(source.chatKey)) {
      chats.push(source.ref);
    }
    if (bits.read !== GROUP_DEFAULT_BITS.read || bits.write !== GROUP_DEFAULT_BITS.write) {
      chatOverrides.push({
        peer: source.ref,
        verbs: bitsToVerbs(bits),
      });
    }
  }

  return {
    chats,
    folders,
    chatOverrides,
    groupVerbs: bitsToVerbs(GROUP_DEFAULT_BITS),
  };
};
