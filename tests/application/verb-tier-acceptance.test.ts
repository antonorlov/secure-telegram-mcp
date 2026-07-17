/**
 * VERB-TIER ACCEPTANCE — the product invariants of the settled verb model, driven
 * through the real use-case engine + ACL with fake ports:
 *
 *  (a) a READ endpoint (picker `r` = {read, read_media}) can read, list pinned, list
 *      participants, AND download media, but every write (react/send/delete/forward/
 *      mark_read/draft) is denied.
 *  (b) a READ+WRITE endpoint (picker `rw` = read tier + full write tier) can do the
 *      whole write surface, including send_reaction and mark_read.
 *  (d) an explicit text-only `{read}` grant denies download_media while read still
 *      works; the kill-switch disables read_media and react INDIVIDUALLY, each leaving
 *      the others intact.
 *
 * (c) the forward two-sided rule is pinned in forwardScope.test.ts; (e) the picker
 * collapse contract in config-picker-mapper.test.ts + config-picker-folder-projection.
 */
import { describe, it, expect } from 'vitest';
import { ok, unwrap, type Result } from '../../src/shared/result.js';
import {
  DefaultAclEvaluator,
  PeerRefFactory,
  PermissionVerb,
  ResolvedScope,
} from '../../src/domain/index.js';
import type { AppError } from '../../src/application/errors.js';
import type {
  ReadUseCaseDeps,
  WriteUseCaseDeps,
} from '../../src/application/index.js';
import type { EndpointExecutionContext } from '../../src/application/use-cases/context.js';
import {
  makeReadUseCase,
  READ_SPECS,
} from '../../src/application/use-cases/read-use-case-impls.js';
import {
  makeWriteUseCase,
  WRITE_SPECS,
} from '../../src/application/use-cases/write-use-case-impls.js';
import {
  buildEndpoint,
  resolvedScope,
  chatId,
  IN_SCOPE,
  NO_DENIED,
  deniedVerbs,
  SpyScopedClient,
  FakeClock,
  RecordingAuditLog,
  StubRateLimiter,
  StubConfirmer,
} from './_support.js';

const IN = PeerRefFactory.fromId(IN_SCOPE);
const readDeps = (): ReadUseCaseDeps => ({
  aclEvaluator: new DefaultAclEvaluator(),
  auditLog: new RecordingAuditLog(),
  clock: new FakeClock(),
  rateLimiter: new StubRateLimiter(ok(undefined)),
});
const writeDeps = (): WriteUseCaseDeps => ({
  ...readDeps(),
  rateLimiter: new StubRateLimiter(ok(undefined)),
  confirmer: new StubConfirmer(ok(true)),
});

/** Run one tool's use-case against a context; returns whether it succeeded. */
const RUNNERS: Record<
  string,
  (ctx: EndpointExecutionContext) => Promise<Result<unknown, AppError>>
> = {
  get_messages: (ctx) => makeReadUseCase(readDeps(), READ_SPECS.getMessages).execute(ctx, { peer: IN, limit: 5 }),
  get_pinned_messages: (ctx) => makeReadUseCase(readDeps(), READ_SPECS.getPinnedMessages).execute(ctx, { peer: IN, limit: 5 }),
  list_participants: (ctx) => makeReadUseCase(readDeps(), READ_SPECS.listParticipants).execute(ctx, { peer: IN, limit: 5 }),
  download_media: (ctx) => makeReadUseCase(readDeps(), READ_SPECS.downloadMedia).execute(ctx, { peer: IN, messageId: 1 }),
  send_reaction: (ctx) => makeWriteUseCase(writeDeps(), WRITE_SPECS.sendReaction).execute(ctx, { peer: IN, messageId: 1, emoji: 'A' }),
  send_message: (ctx) => makeWriteUseCase(writeDeps(), WRITE_SPECS.sendMessage).execute(ctx, { peer: IN, text: 'hi' }),
  delete_message: (ctx) => makeWriteUseCase(writeDeps(), WRITE_SPECS.deleteMessage).execute(ctx, { peer: IN, messageIds: [1], revoke: false }),
  save_draft: (ctx) => makeWriteUseCase(writeDeps(), WRITE_SPECS.saveDraft).execute(ctx, { peer: IN, text: 'd' }),
  mark_read: (ctx) => makeWriteUseCase(writeDeps(), WRITE_SPECS.markRead).execute(ctx, { peer: IN }),
  forward_message: (ctx) => makeWriteUseCase(writeDeps(), WRITE_SPECS.forwardMessage).execute(ctx, { fromPeer: IN, toPeer: IN, messageIds: [1] }),
};

const ctxWith = (
  verbs: readonly PermissionVerb[],
  denied: ReadonlySet<PermissionVerb> = NO_DENIED,
): EndpointExecutionContext => ({
  endpoint: buildEndpoint({ verbs }),
  resolvedScope: resolvedScope(),
  overrides: new Map(),
  deniedVerbs: denied,
  client: new SpyScopedClient(buildEndpoint({ verbs }).name),
});

const succeeds = async (
  name: string,
  verbs: readonly PermissionVerb[],
  denied: ReadonlySet<PermissionVerb> = NO_DENIED,
): Promise<boolean> => {
  const runner = RUNNERS[name];
  if (runner === undefined) throw new Error(`no runner for ${name}`);
  return (await runner(ctxWith(verbs, denied))).ok;
};

/** picker `r` — the read bit expands to the whole passive read tier + media egress. */
const R_GRANT = [PermissionVerb.Read, PermissionVerb.ReadMedia];
/** picker `rw` — read tier + the full write tier. */
const RW_GRANT = [
  PermissionVerb.Read,
  PermissionVerb.ReadMedia,
  PermissionVerb.Send,
  PermissionVerb.Draft,
  PermissionVerb.Delete,
  PermissionVerb.MarkRead,
  PermissionVerb.Forward,
  PermissionVerb.React,
];

describe('(a) a READ (picker r) endpoint: reads + media egress succeed, writes denied', () => {
  for (const tool of ['get_messages', 'get_pinned_messages', 'list_participants', 'download_media']) {
    it(`${tool} SUCCEEDS`, async () => {
      expect(await succeeds(tool, R_GRANT)).toBe(true);
    });
  }
  for (const tool of ['send_reaction', 'send_message', 'delete_message', 'forward_message', 'mark_read', 'save_draft']) {
    it(`${tool} is DENIED`, async () => {
      expect(await succeeds(tool, R_GRANT)).toBe(false);
    });
  }
});

describe('(b) a READ+WRITE (picker rw) endpoint: the full write tier works', () => {
  for (const tool of ['send_reaction', 'mark_read', 'send_message', 'delete_message', 'forward_message', 'save_draft', 'download_media']) {
    it(`${tool} SUCCEEDS`, async () => {
      expect(await succeeds(tool, RW_GRANT)).toBe(true);
    });
  }
});

describe('(d) text-only + INDIVIDUAL kill-switch', () => {
  it('an explicit {read} grant denies download_media but not get_messages', async () => {
    expect(await succeeds('download_media', [PermissionVerb.Read])).toBe(false);
    expect(await succeeds('get_messages', [PermissionVerb.Read])).toBe(true);
  });

  it('kill-switching read_media disables download while read + react keep working', async () => {
    const grant = [PermissionVerb.Read, PermissionVerb.ReadMedia, PermissionVerb.React];
    const denied = deniedVerbs(PermissionVerb.ReadMedia);
    expect(await succeeds('download_media', grant, denied)).toBe(false);
    expect(await succeeds('get_messages', grant, denied)).toBe(true);
    expect(await succeeds('send_reaction', grant, denied)).toBe(true);
  });

  it('kill-switching react disables send_reaction while read + read_media keep working', async () => {
    const grant = [PermissionVerb.Read, PermissionVerb.ReadMedia, PermissionVerb.React];
    const denied = deniedVerbs(PermissionVerb.React);
    expect(await succeeds('send_reaction', grant, denied)).toBe(false);
    expect(await succeeds('download_media', grant, denied)).toBe(true);
    expect(await succeeds('get_messages', grant, denied)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (c continued) PER-CHAT OVERRIDE PRECEDENCE — an override REPLACES the group
// verbs for exactly that chat (chat-override > group-default), for BOTH new
// verbs. Uses a 2-chat scope so "that chat only" is observable: chat A carries
// the override, chat B rides the group default.
// ---------------------------------------------------------------------------

const CHAT_A = IN_SCOPE; // 100
const CHAT_B = chatId(101n);
const PEER_A = PeerRefFactory.fromId(CHAT_A);
const PEER_B = PeerRefFactory.fromId(CHAT_B);
const twoChatScope = (): ResolvedScope =>
  unwrap(ResolvedScope.create([CHAT_A, CHAT_B]));

const ctxOf = (
  groupVerbs: readonly PermissionVerb[],
  overrides: ReadonlyMap<string, ReadonlySet<PermissionVerb>>,
): EndpointExecutionContext => ({
  endpoint: buildEndpoint({ verbs: groupVerbs }),
  resolvedScope: twoChatScope(),
  overrides,
  deniedVerbs: NO_DENIED,
  client: new SpyScopedClient(buildEndpoint({ verbs: groupVerbs }).name),
});

describe('(c) per-chat override REPLACES group verbs (precedence) for react + read_media', () => {
  it('a read-only group + a per-chat override adding react can react in THAT chat only', async () => {
    const overrides = new Map([
      [CHAT_A.toKey(), new Set([PermissionVerb.Read, PermissionVerb.React])],
    ]);
    const react = (peer: typeof PEER_A): Promise<Result<unknown, AppError>> =>
      makeWriteUseCase(writeDeps(), WRITE_SPECS.sendReaction).execute(ctxOf([PermissionVerb.Read], overrides), {
        peer,
        messageId: 1,
        emoji: 'A',
      });

    expect((await react(PEER_A)).ok).toBe(true); // override grants react here
    expect((await react(PEER_B)).ok).toBe(false); // group {read} — no react
  });

  it('a read+read_media group + a per-chat override of {read} is TEXT-ONLY for that chat (download denied there, allowed elsewhere)', async () => {
    const overrides = new Map([
      [CHAT_A.toKey(), new Set([PermissionVerb.Read])], // strip read_media on A
    ]);
    const download = (peer: typeof PEER_A): Promise<Result<unknown, AppError>> =>
      makeReadUseCase(readDeps(), READ_SPECS.downloadMedia).execute(
        ctxOf([PermissionVerb.Read, PermissionVerb.ReadMedia], overrides),
        { peer, messageId: 1 },
      );

    expect((await download(PEER_A)).ok).toBe(false); // override {read} -> text-only
    expect((await download(PEER_B)).ok).toBe(true); // group {read, read_media}
  });

  it('a read-only group + a per-chat override adding read_media can download in THAT chat only', async () => {
    const overrides = new Map([
      [CHAT_A.toKey(), new Set([PermissionVerb.Read, PermissionVerb.ReadMedia])],
    ]);
    const download = (peer: typeof PEER_A): Promise<Result<unknown, AppError>> =>
      makeReadUseCase(readDeps(), READ_SPECS.downloadMedia).execute(ctxOf([PermissionVerb.Read], overrides), {
        peer,
        messageId: 1,
      });

    expect((await download(PEER_A)).ok).toBe(true); // override grants read_media here
    expect((await download(PEER_B)).ok).toBe(false); // group {read} — egress denied
  });
});
