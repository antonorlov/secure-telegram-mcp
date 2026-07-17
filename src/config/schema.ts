/**
 * Config schema — the single authoritative description of the ACL: endpoints,
 * their scope (chats + FOLDERS), granted verbs, and HITL policy. Validates the
 * on-disk file; the interactive `setup` generator writes this same shape.
 *
 * We accept ergonomic string shorthands ('me', '@user', '-100…') and folder
 * id/title, normalising through the DOMAIN factories straight to `PeerRef` /
 * `FolderRef` (one in-memory form, validated once). Endpoint binding later uses
 * a temporary gateway-owned resolver to expand only those declared refs before
 * constructing the scope-bound tool client.
 */
import { z } from 'zod';
import {
  ChatId,
  DEFAULT_CONFIRM_WRITES,
  FolderRefFactory,
  PeerRefFactory,
  SLUG_RE,
  isPermissionVerb,
  type DeclaredChatVerbOverride,
  type FolderRef,
  type PeerRef,
  type PermissionVerb,
} from '../domain/index.js';
import { assertNever, err, isErr, ok, type Result } from '../shared/index.js';

const slug = z
  .string()
  .regex(SLUG_RE, 'must be a lowercase slug (1–64 chars)');

// ---- chat reference ----

/**
 * Normalise a chat-ref shorthand ('me' | '@user' | numeric id) into a domain
 * `PeerRef` via the domain factories (their invariants — id bounds, username
 * shape — are the ONLY validation; nothing is re-checked later). Both
 * `scope.chats` and the `scope.chatOverrides` keys normalise through this ONE
 * path so an override key and a scope chat resolve to the SAME ref — otherwise
 * chat-override > group-default precedence could never line up by identity.
 */
export const parseChatRef = (raw: string): Result<PeerRef, string> => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return err('chat reference must not be empty');
  }
  if (trimmed === 'me') {
    return ok(PeerRefFactory.me());
  }
  if (trimmed.startsWith('@')) {
    const parsed = PeerRefFactory.fromUsername(trimmed.slice(1));
    return isErr(parsed) ? err(parsed.error.message) : parsed;
  }
  if (/^-?\d+$/.test(trimmed)) {
    const id = ChatId.fromString(trimmed);
    return isErr(id) ? err(id.error.message) : ok(PeerRefFactory.fromId(id.value));
  }
  return err(
    `Invalid chat reference '${raw}' (use 'me', '@username', or a numeric id)`,
  );
};

/**
 * Render a `PeerRef` back to its ergonomic on-disk shorthand — the single
 * inverse of {@link parseChatRef}, so the round-trip pair lives in one module
 * and a shorthand-grammar change is made in exactly one place. Ids re-emit in
 * `ChatId`'s canonical decimal form (lossless by identity).
 */
export const chatEntryToRef = (entry: PeerRef): string => {
  switch (entry.kind) {
    case 'me':
      return 'me';
    case 'username':
      return `@${entry.username}`;
    case 'id':
      return entry.id.toKey();
    default:
      return assertNever(entry, 'chatEntryToRef');
  }
};

const chatEntrySchema = z
  .string()
  .transform((raw, ctx): PeerRef => {
    const parsed = parseChatRef(raw);
    if (isErr(parsed)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: parsed.error });
      return z.NEVER;
    }
    return parsed.value;
  });

// ---- folder reference ----

/** The on-disk value of a folder ref (numeric id or title) — the serialization inverse. */
export const folderEntryValue = (entry: FolderRef): number | string =>
  entry.kind === 'id' ? entry.id : entry.title;

const folderEntrySchema = z
  .union([z.number(), z.string()])
  .transform((raw, ctx): FolderRef => {
    const parsed =
      typeof raw === 'number'
        ? FolderRefFactory.fromId(raw)
        : FolderRefFactory.fromTitle(raw);
    if (isErr(parsed)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: parsed.error.message });
      return z.NEVER;
    }
    return parsed.value;
  });

// ---- permission verb ----

const permissionVerbSchema: z.ZodType<PermissionVerb> = z.custom<PermissionVerb>(
  isPermissionVerb,
  { message: 'Unknown permission verb' },
);

// ---- per-chat verb override ----

/**
 * On disk a per-chat verb override is the ergonomic record
 * `{ "<chatRef>": ["read", ...] }`; it normalises to the domain's
 * `DeclaredChatVerbOverride` (the same `PeerRef` language as `scope.chats`)
 * whose verbs REPLACE the group default for that chat.
 *
 * SECURITY: this only NARROWS or RE-SHAPES access WITHIN the endpoint's
 * already-scoped allow-list — the override chat must still be in scope to matter,
 * and an unknown verb is rejected by the same verb check.
 */
const chatOverridesSchema = z
  .record(z.string(), z.array(permissionVerbSchema).nonempty('an override must grant at least one verb'))
  .default({})
  .transform((record, ctx): readonly DeclaredChatVerbOverride[] => {
    const out: DeclaredChatVerbOverride[] = [];
    for (const [ref, verbs] of Object.entries(record)) {
      const parsed = parseChatRef(ref);
      if (isErr(parsed)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `chatOverrides key: ${parsed.error}`,
        });
        return z.NEVER;
      }
      out.push({ peer: parsed.value, verbs });
    }
    return out;
  });

// ---- scope ----

const scopeSchema = z
  .object({
    chats: z.array(chatEntrySchema).default([]),
    folders: z.array(folderEntrySchema).default([]),
    /** Optional; an absent field maps to an empty override set (group-default). */
    chatOverrides: chatOverridesSchema,
  })
  .strict();

// ---- hitl ----

const hitlSchema = z
  .object({
    confirmWrites: z.boolean().default(DEFAULT_CONFIRM_WRITES),
  })
  .strict()
  .default({ confirmWrites: DEFAULT_CONFIRM_WRITES });

// ---- endpoint ----

const endpointSchema = z
  .object({
    /** Unique endpoint name (used in tool / server ids). */
    name: slug,
    /** Reference to the encrypted session this endpoint uses. */
    session: slug,
    scope: scopeSchema,
    verbs: z
      .array(permissionVerbSchema)
      .nonempty('an endpoint must grant at least one verb'),
    hitl: hitlSchema,
    /** SHA-256 of the endpoint API key (REQUIRED authorization gate — never key material). */
    tokenHash: z
      .string()
      .regex(/^[0-9a-f]{32}\$[0-9a-f]{64}$/, 'tokenHash must be a salted digest (<salt>$<hash>)'),
  })
  .strict();

// ---- kill switch ----

const killSwitchSchema = z
  .object({
    disabledVerbs: z.array(permissionVerbSchema).default([]),
  })
  .strict()
  .default({ disabledVerbs: [] });

// ---- download egress cap (global, operator-configurable) ----

/**
 * Global DOWNLOAD egress cap (bytes) for `download_media`. A resource guard for the
 * operator's own disk — NOT a security boundary (unlike the fixed output/context byte
 * caps) — so it is operator-configurable. Positive integer with a generous sanity
 * ceiling (~4 GiB, above Telegram's own per-file limit). Absent -> the runtime default
 * (50 MiB). One GLOBAL knob; per-endpoint granularity is deliberately not offered.
 */
const maxDownloadBytesSchema = z
  .number()
  .int()
  .positive()
  .max(4 * 1024 * 1024 * 1024, 'maxDownloadBytes exceeds the 4 GiB sanity ceiling')
  .optional();

// ---- root ----

export const configSchema = z
  .object({
    version: z.literal(1),
    killSwitch: killSwitchSchema,
    maxDownloadBytes: maxDownloadBytesSchema,
    endpoints: z
      .array(endpointSchema)
      .nonempty('at least one endpoint must be defined'),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    // Endpoint names must be unique.
    const seen = new Set<string>();
    cfg.endpoints.forEach((ep, i) => {
      if (seen.has(ep.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate endpoint name '${ep.name}'`,
          path: ['endpoints', i, 'name'],
        });
      }
      seen.add(ep.name);
    });
  });

/** The validated, normalised config (output type after transforms/defaults). */
export type ValidatedConfig = z.infer<typeof configSchema>;
export type ValidatedEndpoint = ValidatedConfig['endpoints'][number];
export type ValidatedScope = ValidatedEndpoint['scope'];
