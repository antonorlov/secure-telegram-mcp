/**
 * Lossless projection editor over the config: the enumeration DTOs, the pure projection
 * functions and the bit<->verb translation. Framework-free — it depends only on the config
 * types, the domain verb vocabulary and the picker model.
 * THE 2-BIT PROJECTION. The picker edits access as two independent bits (read / write — the
 * chmod model) while the config stores the full least-privilege verb vocabulary. Each set bit
 * expands to its whole tier, so a hand-authored narrower set such as `[read]` or `[read,
 * mark_read]` COLLAPSES to the tier the moment that chat is edited in the picker. Round-trip is
 * membership- and tier-stable, not verb-identical.
 * Chat-ref FORM normalizes on commit: 'me' and numeric ids re-emit as-is, while a hand-authored
 * '@username' matches its enumerated chat and re-emits as a canonical numeric id — membership
 * survives, the spelling does not.
 * SECURITY: projection only ever shapes access within the membership the operator picked. A
 * chat is a member only if it is selected, an override only emits for a member, and an absent
 * selection entry stays a non-member — default-deny preserved.
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

// Bridges the config's chat references ('me' / '@user' / id) to the picker's canonical
// `ChatKey`, and carries which folder rows a chat belongs to for cross-folder dedup.
export interface PickerChatSource {
  readonly chatKey: ChatKey;
  readonly ref: PeerRef;
  readonly title: string;
  readonly username?: string;
}

export interface PickerFolderSource {
  readonly id: number;
  readonly title: string;
  readonly childChatKeys: readonly ChatKey[];
  /**
   * The EXPLICIT (pinned ∪ included) member keys — the only ones the runtime resolver tracks
   * for a `folders[]` ref. Rule-matched members are snapshotted as individual chats. Defaults
   * to `childChatKeys` when omitted.
   */
  readonly explicitChatKeys?: readonly ChatKey[];
}

export interface PickerEnumeration {
  readonly chats: readonly PickerChatSource[];
  readonly folders: readonly PickerFolderSource[];
}

export interface HydrateInput {
  // Hydration resolves them into explicit per-chat bits — membership IS access, there is no
  // inherit layer — so a member without a `chatOverride` gets these bits made explicit.
  readonly groupVerbs: readonly Verb[];
  readonly scope: ValidatedScope;
  readonly enumeration: PickerEnumeration;
}

// Folders picked as a scope unit project to `folders[]` and their explicit members are
// de-duplicated, while rule-matched members are emitted as stable `chats[]` snapshots.
export interface ProjectedScope {
  // A hand-authored '@username' member re-emits as its id: membership preserved, form
  // normalized.
  readonly chats: readonly PeerRef[];
  readonly folders: readonly FolderRef[];
  readonly chatOverrides: readonly DeclaredChatVerbOverride[];
  readonly groupVerbs: readonly Verb[];
}

/**
 * Configured refs that no live-enumerated chat or folder matches — a chat that left, or a
 * folder renamed since the config was written. Hydration cannot pre-check them and a commit
 * would drop them silently, so the editor surfaces them for explicit confirmation.
 */
export interface UnmatchedRefs {
  readonly chats: readonly string[];
  readonly folders: readonly string[];
}

// The full READ tier a read bit expands to. DERIVED from the domain verb vocabulary, never
// restated by hand, so a new verb cannot drift between detection and projection.
const READ_TIER_VERBS: readonly Verb[] = Object.freeze(
  ALL_PERMISSION_VERBS.filter(isReadVerb),
);
// The full WRITE tier, derived like the read tier.
const WRITE_TIER_VERBS: readonly Verb[] = Object.freeze(
  ALL_PERMISSION_VERBS.filter(isWriteVerb),
);
// Security-first group default: read-only. Members with exactly these bits ride on it; anything
// else emits an explicit per-chat override.
const GROUP_DEFAULT_BITS: AccessBits = Object.freeze({ read: true, write: false });

// Each set bit expands to its FULL tier — the one place the picker's r/w maps onto the verb
// vocabulary.
export const bitsToVerbs = (bits: AccessBits): readonly Verb[] => {
  const verbs: Verb[] = [];
  if (bits.read) verbs.push(...READ_TIER_VERBS);
  if (bits.write) verbs.push(...WRITE_TIER_VERBS);
  return verbs;
};

// Via the domain tier predicates, so a hand-configured chat still shows the right bits:
// read_media -> read, react and mark_read -> write.
export const verbsToBits = (verbs: readonly Verb[]): AccessBits => ({
  read: verbs.some(isReadVerb),
  write: verbs.some(isWriteVerb),
});

/**
 * Usernames fold to lower case (Telegram usernames are case-insensitive) and numeric ids use
 * `ChatId`'s canonical decimal key, so a `scope.chats` entry and a `chatOverrides` key line up
 * with the live enumeration by identity.
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
 * Does a folder mark actually COMMIT as a `folders[]` scope-unit ref? The ref covers exactly
 * the folder's EXPLICIT (pinned ∪ included) members, so it commits only while the folder is
 * marked, every explicit member is still selected, and it has at least one explicit member —
 * unless its live membership is unenumerated, where a config-authored ref is preserved
 * vacuously. A folder with rule members but none explicit would resolve to zero peers at
 * runtime.
 * The ONE predicate shared by the projection and the review screen, so the review never
 * describes a folder unit the commit would drop.
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

// The ONE definition of "does a config ref match a live-enumerated chat or folder", used by
// both hydrate and unmatchedRefs, so they can never disagree.

/**
 * Each enumerated chat registers both its canonical ref and, when it has a username, the
 * '@username' identity — so a hand-authored '@user' entry lands on the same enumerated chat
 * instead of hydrating unchecked and then being dropped on commit.
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

const matchFolderRef = (
  ref: FolderRef,
  enumeration: PickerEnumeration,
): PickerFolderSource | undefined =>
  enumeration.folders.find((folder) =>
    ref.kind === 'id' ? folder.id === ref.id : folder.title === ref.title,
  );

const folderRefText = (ref: FolderRef): string =>
  ref.kind === 'id' ? `#${String(ref.id)}` : ref.title;

/**
 * Members come from `scope.chats`, each with explicit bits: the `chatOverride` bits when
 * declared, else the endpoint `groupVerbs` resolved to bits. An empty scope yields an empty
 * selection — default-deny.
 */
export const hydratePickerSelection = (
  input: HydrateInput,
): PickerSelectionModel => {
  const { scope, groupVerbs, enumeration } = input;
  const groupBits = verbsToBits(groupVerbs);

  const keyByRef = buildChatKeyByRef(enumeration);

  // Pre-resolve the per-chat override bits by chatKey; the config record cannot hold duplicate
  // keys, so there is at most one.
  const overrideBits = new Map<ChatKey, AccessBits>();
  for (const ov of scope.chatOverrides) {
    const chatKey = keyByRef.get(refIdentity(ov.peer));
    if (chatKey !== undefined) {
      overrideBits.set(chatKey, verbsToBits(ov.verbs));
    }
  }

  const bitsFor = (chatKey: ChatKey): AccessBits =>
    overrideBits.get(chatKey) ?? groupBits;

  const selection = new Map<ChatKey, AccessBits>();
  for (const chat of scope.chats) {
    const chatKey = keyByRef.get(refIdentity(chat));
    if (chatKey === undefined) continue; // ref not enumerated (stale) — skip.
    selection.set(chatKey, bitsFor(chatKey));
  }

  /**
   * A declared `folders[]` ref pre-marks that folder as a scope unit and pre-checks its
   * EXPLICIT members — the set the runtime ref actually tracks — so the picker shows what will
   * really be scoped. Rule-matched members are not pre-checked; any that were snapshotted
   * return through `scope.chats` as individual chats.
   */
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

// Uses the SAME matching as hydration, so the editor can surface a rename or departure before
// an edit silently drops it.
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
 * The inverse of hydration at the membership and tier level. Members emit a `chats` ref in the
 * canonical enumerated form; the emitted `groupVerbs` are the read-only default, and any member
 * whose bits differ emits a `chatOverride`.
 */
export const projectPickerSelection = (
  model: PickerSelectionModel,
  enumeration: PickerEnumeration,
): ProjectedScope => {
  /**
   * 1. Folders picked as a scope unit: emit as `folders[]` (canonical id form) only while
   * {@link isCommittedFolderUnit} holds — the SAME predicate the review screen renders from, so
   * what is reviewed is what commits. (`folderScope` can only hold an EMPTY folder via
   * hydration: the reducer's `setFolderAccess` no-ops there, so the picker can never CREATE a
   * ref that would silently widen the ACL once the folder gains chats.) Member chats are marked
   * covered so they are not double-emitted.
   */
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

  /**
   * 2. Individually-picked member chats (those not covered by a scope folder) emit a `chats`
   * ref; any member whose bits differ from the read-only default emits an override (overrides
   * ride alongside folder scope).
   */
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
