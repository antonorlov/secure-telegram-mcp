/**
 * SOLE-GATE COMPLETENESS (the load-bearing guarantee once the menu is STATIC and
 * the AclGuardedScopedClient decorator is gone).
 *
 * The per-chat verb+scope+kill check inside the USE-CASE ENGINE
 * (resolve -> ACL -> audit) is now the ONLY application-layer gate. This
 * table-driven suite proves that guarantee is COMPLETE: EVERY core tool's
 * use-case denies both
 *   (a) an OUT-OF-VERB call — the tool's verb is daemon-denied (kill-switched) —
 *       and
 *   (b) an OUT-OF-SCOPE id peer,
 * fail-closed with AclDenied, with the scoped client's DATA method NEVER reached
 * (only peer resolution runs) — so no tool can act or return data without the
 * check.
 *
 * Synthetic ENGLISH fixtures + fake ids only.
 */
import { describe, it, expect } from 'vitest';
import { ok } from '../../src/shared/index.js';
import type { Result } from '../../src/shared/index.js';
import {
  DefaultAclEvaluator,
  PeerRefFactory,
  PermissionVerb,
} from '../../src/domain/index.js';
import type { PeerRef } from '../../src/domain/index.js';
import { AppErrorCode } from '../../src/application/errors.js';
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
  createPrepareMediaUseCase,
} from '../../src/application/use-cases/write-use-case-impls.js';
import { buildToolDefinitions } from '../../src/presentation/mcp/tools/index.js';
import {
  buildEndpoint,
  resolvedScope,
  IN_SCOPE,
  OUT_OF_SCOPE,
  NO_DENIED,
  SpyScopedClient,
  FakeClock,
  RecordingAuditLog,
  StubRateLimiter,
  StubConfirmer,
} from './_support.js';

/** Every verb the core tools use (so out-of-verb is via the denied set). */
const CORE_VERBS: readonly PermissionVerb[] = [
  PermissionVerb.Read,
  PermissionVerb.ReadMedia,
  PermissionVerb.Send,
  PermissionVerb.Delete,
  PermissionVerb.Draft,
  PermissionVerb.MarkRead,
  PermissionVerb.Forward,
  PermissionVerb.React,
];

const readDeps = (): ReadUseCaseDeps => ({
  aclEvaluator: new DefaultAclEvaluator(),
  auditLog: new RecordingAuditLog(),
  clock: new FakeClock(),
  rateLimiter: new StubRateLimiter(ok(undefined)),
});
const searchDeps = (): ReadUseCaseDeps => ({
  ...readDeps(),
  rateLimiter: new StubRateLimiter(ok(undefined)),
});
const writeDeps = (): WriteUseCaseDeps => ({
  ...readDeps(),
  rateLimiter: new StubRateLimiter(ok(undefined)),
  confirmer: new StubConfirmer(ok(true)),
});

interface ToolProbe {
  readonly name: string;
  readonly verb: PermissionVerb;
  /** Number of peer refs canonicalized before the ACL decision. */
  readonly resolvedPeers: number;
  /** False for verb-only ops (no id peer): scope is enforced physically inner. */
  readonly hasPeer: boolean;
  /** Build the use-case and run it against the given context + peer. */
  readonly run: (
    ctx: EndpointExecutionContext,
    peer: PeerRef,
  ) => Promise<Result<unknown, AppError>>;
}

// Every core tool path, each mapped to its use-case + verb (the closure test
// below derives the required membership from the shipped catalogue).
const PROBES: readonly ToolProbe[] = [
  { name: 'get_messages', verb: PermissionVerb.Read, resolvedPeers: 1, hasPeer: true,
    run: (ctx, peer) => makeReadUseCase(readDeps(), READ_SPECS.getMessages).execute(ctx, { peer, limit: 10 }) },
  { name: 'search_messages', verb: PermissionVerb.Read, resolvedPeers: 1, hasPeer: true,
    run: (ctx, peer) => makeReadUseCase(searchDeps(), READ_SPECS.searchMessages).execute(ctx, { peer, query: 'hello', limit: 10 }) },
  { name: 'list_dialogs', verb: PermissionVerb.Read, resolvedPeers: 0, hasPeer: false,
    run: (ctx) => makeReadUseCase(readDeps(), READ_SPECS.listDialogs).execute(ctx, { limit: 10 }) },
  { name: 'list_topics', verb: PermissionVerb.Read, resolvedPeers: 1, hasPeer: true,
    run: (ctx, peer) => makeReadUseCase(readDeps(), READ_SPECS.listTopics).execute(ctx, { peer, limit: 10 }) },
  { name: 'get_chat_info', verb: PermissionVerb.Read, resolvedPeers: 1, hasPeer: true,
    run: (ctx, peer) => makeReadUseCase(readDeps(), READ_SPECS.getChatInfo).execute(ctx, { peer }) },
  { name: 'get_media_info', verb: PermissionVerb.Read, resolvedPeers: 1, hasPeer: true,
    run: (ctx, peer) => makeReadUseCase(readDeps(), READ_SPECS.getMediaInfo).execute(ctx, { peer, messageId: 1 }) },
  { name: 'get_pinned_messages', verb: PermissionVerb.Read, resolvedPeers: 1, hasPeer: true,
    run: (ctx, peer) => makeReadUseCase(readDeps(), READ_SPECS.getPinnedMessages).execute(ctx, { peer, limit: 10 }) },
  { name: 'list_participants', verb: PermissionVerb.Read, resolvedPeers: 1, hasPeer: true,
    run: (ctx, peer) => makeReadUseCase(readDeps(), READ_SPECS.listParticipants).execute(ctx, { peer, limit: 10 }) },
  { name: 'download_media', verb: PermissionVerb.ReadMedia, resolvedPeers: 1, hasPeer: true,
    run: (ctx, peer) => makeReadUseCase(readDeps(), READ_SPECS.downloadMedia).execute(ctx, { peer, messageId: 1 }) },
  { name: 'send_reaction', verb: PermissionVerb.React, resolvedPeers: 1, hasPeer: true,
    run: (ctx, peer) => makeWriteUseCase(writeDeps(), WRITE_SPECS.sendReaction).execute(ctx, { peer, messageId: 1, emoji: 'A' }) },
  { name: 'send_message', verb: PermissionVerb.Send, resolvedPeers: 1, hasPeer: true,
    run: (ctx, peer) => makeWriteUseCase(writeDeps(), WRITE_SPECS.sendMessage).execute(ctx, { peer, text: 'hi' }) },
  { name: 'edit_message', verb: PermissionVerb.Send, resolvedPeers: 1, hasPeer: true,
    run: (ctx, peer) => makeWriteUseCase(writeDeps(), WRITE_SPECS.editMessage).execute(ctx, { peer, messageId: 1, text: 'hi' }) },
  { name: 'delete_message', verb: PermissionVerb.Delete, resolvedPeers: 1, hasPeer: true,
    run: (ctx, peer) => makeWriteUseCase(writeDeps(), WRITE_SPECS.deleteMessage).execute(ctx, { peer, messageIds: [1], revoke: false }) },
  { name: 'save_draft', verb: PermissionVerb.Draft, resolvedPeers: 1, hasPeer: true,
    run: (ctx, peer) => makeWriteUseCase(writeDeps(), WRITE_SPECS.saveDraft).execute(ctx, { peer, text: 'draft' }) },
  { name: 'mark_read', verb: PermissionVerb.MarkRead, resolvedPeers: 1, hasPeer: true,
    run: (ctx, peer) => makeWriteUseCase(writeDeps(), WRITE_SPECS.markRead).execute(ctx, { peer }) },
  { name: 'forward_message', verb: PermissionVerb.Forward, resolvedPeers: 2, hasPeer: true,
    run: (ctx, peer) => makeWriteUseCase(writeDeps(), WRITE_SPECS.forwardMessage).execute(ctx, { fromPeer: peer, toPeer: peer, messageIds: [1] }) },
  { name: 'prepare_media', verb: PermissionVerb.Send, resolvedPeers: 0, hasPeer: false,
    run: (ctx) => createPrepareMediaUseCase(readDeps()).execute(ctx, { localPath: '/tmp/x.bin' }) },
  { name: 'send_media', verb: PermissionVerb.Send, resolvedPeers: 1, hasPeer: true,
    run: (ctx, peer) => makeWriteUseCase(writeDeps(), WRITE_SPECS.sendMedia).execute(ctx, { peer, handle: 'opaque-handle' }) },
];

const resolveCalls = (count: number): string[] =>
  Array.from({ length: count }, () => 'resolvePeer');

/** Context granting EVERY core verb, so ONLY the denied set / scope can deny. */
const ctxWith = (
  inner: SpyScopedClient,
  denied: ReadonlySet<PermissionVerb>,
): EndpointExecutionContext => ({
  endpoint: buildEndpoint({ verbs: CORE_VERBS }),
  resolvedScope: resolvedScope(),
  overrides: new Map(),
  deniedVerbs: denied,
  client: inner,
});

describe('sole-gate completeness — every tool denies out-of-verb + out-of-scope', () => {
  for (const probe of PROBES) {
    it(`${probe.name}: DENIES an out-of-verb (kill-switched) call, data method never reached`, async () => {
      // The tool's verb is daemon-denied; the peer is IN scope, so ONLY the verb
      // gate can deny — proving every tool honours the verb check.
      const inner = new SpyScopedClient(buildEndpoint({ verbs: [] }).name);
      const ctx = ctxWith(inner, new Set([probe.verb]));
      const result = await probe.run(ctx, PeerRefFactory.fromId(IN_SCOPE));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe(AppErrorCode.AclDenied);
      expect(inner.calls).toEqual(resolveCalls(probe.resolvedPeers));
    });

    if (probe.hasPeer) {
      it(`${probe.name}: DENIES an out-of-scope id peer, data method never reached`, async () => {
        const inner = new SpyScopedClient(buildEndpoint({ verbs: [] }).name);
        const ctx = ctxWith(inner, NO_DENIED);
        const result = await probe.run(ctx, PeerRefFactory.fromId(OUT_OF_SCOPE));
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code).toBe(AppErrorCode.AclDenied);
        expect(inner.calls).toEqual(resolveCalls(probe.resolvedPeers));
      });
    }
  }

  it('probes EVERY tool in the SHIPPED catalogue, which is exactly the spec tables + prepare_media', () => {
    const snake = (key: string): string =>
      key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    const fromSpecs = [
      ...Object.keys(READ_SPECS).map(snake),
      ...Object.keys(WRITE_SPECS).map(snake),
      'prepare_media',
    ].sort();
    const shipped = buildToolDefinitions(writeDeps())
      .map((definition) => definition.name)
      .sort();
    // Mechanical closure both ways: specs <-> shipped catalogue <-> probes. A
    // bespoke tool wired into the catalogue without a spec entry (or a spec
    // entry never wired) breaks the first assertion; a probe gap breaks the second.
    expect(shipped).toEqual(fromSpecs);
    expect(PROBES.map((p) => p.name).sort()).toEqual(shipped);
  });
});
