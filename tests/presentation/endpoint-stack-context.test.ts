/**
 * resolveEndpointRuntime COMPOSITION-ROOT test: the context every use-case
 * receives must carry the daemon-denied verbs and thread the resolved scope,
 * overrides, and bound client through UNCHANGED — pinned against the REAL
 * production function over a fake session stack. Honest scope note: while
 * the denied set is kill-switch-only, its composition is observably
 * identical to the union, so this test proves kill-switch propagation today
 * and becomes discriminating for the default-off term only once that tuple
 * gains its first member.
 */
import { describe, it, expect } from 'vitest';
import { ok, type Result } from '../../src/shared/index.js';
import {
  PermissionVerb,
  type ChatVerbOverrideTable,
} from '../../src/domain/index.js';
import type { AppError } from '../../src/application/errors.js';
import type { ResolvedAccess } from '../../src/application/dtos/endpoint-access.js';
import type { ScopedClient } from '../../src/application/ports/scoped-client.js';
import {
  resolveEndpointRuntime,
  type SessionStack,
} from '../../src/presentation/mcp/endpoint-stack.js';
import {
  buildEndpoint,
  resolvedScope,
  killSwitch,
  noKillSwitch,
  SpyScopedClient,
  IN_SCOPE,
} from '../application/_support.js';

const endpoint = buildEndpoint({ verbs: [PermissionVerb.Read] });
const client = new SpyScopedClient(endpoint.name);

/** Only the members resolveEndpointRuntime touches; the cast supplies the rest. */
const fakeStack = (overrides: ChatVerbOverrideTable): SessionStack =>
  ({
    folderResolver: {
      resolve: (): Promise<Result<ResolvedAccess, AppError>> =>
        Promise.resolve(ok({ scope: resolvedScope(), overrides })),
    },
    gateway: {
      bindScopedClient: (): Promise<Result<ScopedClient, AppError>> =>
        Promise.resolve(ok(client)),
      releaseScopedClient: (): Promise<void> => Promise.resolve(),
    },
  }) as unknown as SessionStack;

describe('resolveEndpointRuntime (the real composition root)', () => {
  it('composes the kill-switch into the context deniedVerbs', async () => {
    const runtime = await resolveEndpointRuntime({
      endpoint,
      killSwitch: killSwitch(PermissionVerb.Send),
      stack: fakeStack(new Map()),
      log: () => undefined,
    });
    const ctx = runtime.context;
    expect(ctx.deniedVerbs.has(PermissionVerb.Send)).toBe(true);
    expect(ctx.deniedVerbs.size).toBe(1);
    await runtime.dispose();
  });

  it('threads endpoint, resolved scope, overrides, and the bound client through', async () => {
    const overrides: ChatVerbOverrideTable = new Map([
      [IN_SCOPE.toKey(), new Set([PermissionVerb.Read])],
    ]);
    const runtime = await resolveEndpointRuntime({
      endpoint,
      killSwitch: noKillSwitch(),
      stack: fakeStack(overrides),
      log: () => undefined,
    });
    const ctx = runtime.context;
    expect(ctx.deniedVerbs.size).toBe(0);
    expect(ctx.endpoint).toBe(endpoint);
    expect(ctx.resolvedScope.size).toBe(1);
    expect(ctx.overrides).toBe(overrides);
    expect(ctx.client).toBe(client);
    await runtime.dispose();
  });
});
