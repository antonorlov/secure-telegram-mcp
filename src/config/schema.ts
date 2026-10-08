/**
 * The single authoritative description of the ACL. Ergonomic shorthands ('me', '@user',
 * '-100…', folder id or title) normalise through the DOMAIN factories straight to `PeerRef` /
 * `FolderRef`, so there is one in-memory form, validated once.
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

/**
 * Both `scope.chats` and the `scope.chatOverrides` keys normalise through this ONE path, so an
 * override key and a scope chat resolve to the same ref — otherwise chat-override >
 * group-default precedence could never line up by identity. The domain factories' invariants
 * are the only validation.
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

// The single inverse of `parseChatRef`; ids re-emit in `ChatId`'s canonical decimal form.
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

const permissionVerbSchema: z.ZodType<PermissionVerb> = z.custom<PermissionVerb>(
  isPermissionVerb,
  { message: 'Unknown permission verb' },
);

/**
 * An override's verbs REPLACE the group default for that chat. SECURITY: this only narrows or
 * re-shapes access WITHIN the endpoint's already-scoped allow-list — the chat must still be in
 * scope to matter.
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

const scopeSchema = z
  .object({
    chats: z.array(chatEntrySchema).default([]),
    folders: z.array(folderEntrySchema).default([]),
    chatOverrides: chatOverridesSchema,
  })
  .strict();

const hitlSchema = z
  .object({
    confirmWrites: z.boolean().default(DEFAULT_CONFIRM_WRITES),
  })
  .strict()
  .default({ confirmWrites: DEFAULT_CONFIRM_WRITES });

const endpointSchema = z
  .object({
    name: slug,
    session: slug,
    scope: scopeSchema,
    verbs: z
      .array(permissionVerbSchema)
      .nonempty('an endpoint must grant at least one verb'),
    hitl: hitlSchema,
    // SHA-256 of the endpoint API key — authorization data, never key material.
    tokenHash: z
      .string()
      .regex(/^[0-9a-f]{32}\$[0-9a-f]{64}$/, 'tokenHash must be a salted digest (<salt>$<hash>)'),
  })
  .strict();

const killSwitchSchema = z
  .object({
    disabledVerbs: z.array(permissionVerbSchema).default([]),
  })
  .strict()
  .default({ disabledVerbs: [] });

/**
 * A resource guard for the operator's own disk, not a security boundary, so it stays
 * operator-configurable. Positive integer with a ~4 GiB sanity ceiling; absent means the 50 MiB
 * runtime default. One global knob — per-endpoint granularity is deliberately not offered.
 */
const maxDownloadBytesSchema = z
  .number()
  .int()
  .positive()
  .max(4 * 1024 * 1024 * 1024, 'maxDownloadBytes exceeds the 4 GiB sanity ceiling')
  .optional();

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

export type ValidatedConfig = z.infer<typeof configSchema>;
export type ValidatedEndpoint = ValidatedConfig['endpoints'][number];
export type ValidatedScope = ValidatedEndpoint['scope'];
