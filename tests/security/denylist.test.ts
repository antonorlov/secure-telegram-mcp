/**
 * CI DENYLIST GUARD (INVARIANT #2) — a BUILD-FAILING test that fails closed if a
 * forbidden capability ever becomes reachable. It guards two surfaces:
 *
 *  A. The REGISTERED TOOL SURFACE (what the model can actually call): the wired
 *     catalogue must be EXACTLY the curated v1 core set — no raw `invoke`, no
 *     scope-mutation (folder CRUD), no account-global mutation, no
 *     join/import/resolve-username tool, and no admin-tier tool (admin suite is
 *     deferred). The verb-gated registry must also REFUSE a forbidden tool name
 *     at registration time, not merely omit it.
 *
 *  B. The DATA-LAYER REACHABILITY (what the code could be made to call): no
 *     forbidden MTProto request constructor (scope/account/membership mutation)
 *     may appear anywhere under `src/`, so even an internal mistake cannot wire a
 *     dangerous method behind an otherwise-innocent tool.
 *
 * This complements `scripts/check-architecture.mjs` (run via `npm run guard`)
 * with a richer, runtime view of the actual tool objects.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { err, ok, type Result } from '../../src/shared/index.js';
import {
  DefaultAclEvaluator,
  PermissionVerb,
} from '../../src/domain/index.js';
import {
  appError,
  AppErrorCode,
  type AppError,
  type EndpointExecutionContext,
  type WriteUseCaseDeps,
} from '../../src/application/index.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ToolRegistry,
  type AnyToolDefinition,
  type ToolOutput,
} from '../../src/presentation/mcp/registry.js';
import { buildToolDefinitions } from '../../src/presentation/mcp/tools/index.js';
import { OPERATOR_OPERATIONS } from '../../src/presentation/operator/protocol.js';
import {
  buildEndpoint,
  resolvedScope,
  SpyScopedClient,
  NO_DENIED,
  FakeClock,
  RecordingAuditLog,
  StubRateLimiter,
  StubConfirmer,
} from '../application/_support.js';

// --- Engine deps bundle: the catalogue builds every use-case from the spec
// tables; none is ever EXECUTED here (the registry only reads name/requiredVerb).
const stubDeps = (): WriteUseCaseDeps => ({
  aclEvaluator: new DefaultAclEvaluator(),
  rateLimiter: new StubRateLimiter(ok(undefined)),
  confirmer: new StubConfirmer(ok(true)),
  auditLog: new RecordingAuditLog(),
  clock: new FakeClock(),
});

/** The complete, curated v1 core tool surface — the ONLY names allowed to exist. */
const EXPECTED_TOOLS: readonly string[] = [
  'get_messages',
  'search_messages',
  'list_dialogs',
  'list_topics',
  'get_chat_info',
  'get_media_info',
  'get_pinned_messages',
  'list_participants',
  'download_media',
  'send_message',
  'edit_message',
  'delete_message',
  'save_draft',
  'mark_read',
  'forward_message',
  'send_reaction',
  'prepare_media',
  'send_media',
];

/** Verbs a v1 tool is permitted to require (admin tier is deferred, #4/#10). */
const ALLOWED_V1_VERBS: ReadonlySet<PermissionVerb> = new Set<PermissionVerb>([
  PermissionVerb.Read,
  PermissionVerb.ReadMedia,
  PermissionVerb.Send,
  PermissionVerb.Draft,
  PermissionVerb.Delete,
  PermissionVerb.MarkRead,
  PermissionVerb.Forward,
  PermissionVerb.React,
]);

/**
 * Capabilities that must never be exposed AS A TOOL NAME (#2). A registered tool
 * name matching any of these fails the build, even if it is otherwise unique.
 */
const FORBIDDEN_NAME_PATTERNS: readonly { readonly re: RegExp; readonly why: string }[] = [
  { re: /^invoke$|^raw|request|mtproto/i, why: 'raw MTProto passthrough' },
  { re: /scope|grant|revoke|permission|set_/i, why: 'scope/permission mutation' },
  { re: /add_chat|remove_chat|dialog_filter|folder|killswitch/i, why: 'scope/folder CRUD' },
  { re: /privacy|account|logout|reset/i, why: 'account-global mutation' },
  { re: /admin|promote|\bban\b|kick|restrict/i, why: 'admin-tier mutation' },
  { re: /join|import.?invite|resolve|username|lookup/i, why: 'join/import/resolve-username' },
  { re: /photo|avatar|profile/i, why: 'profile/photo mutation' },
];

const catalogueNames = (): readonly string[] =>
  buildToolDefinitions(stubDeps()).map((d) => d.name);

describe('denylist guard — registered tool surface (#2)', () => {
  it('exposes EXACTLY the curated v1 core tools (no stub/extra/forbidden tool)', () => {
    expect([...catalogueNames()].sort()).toEqual([...EXPECTED_TOOLS].sort());
  });

  it('exposes no operator-plane operation as an MCP tool', () => {
    const names = new Set(catalogueNames());
    for (const operation of OPERATOR_OPERATIONS) {
      expect(names.has(operation)).toBe(false);
    }
  });

  it('exposes no tool name resembling a forbidden capability', () => {
    const offenders: string[] = [];
    for (const name of catalogueNames()) {
      for (const { re, why } of FORBIDDEN_NAME_PATTERNS) {
        if (re.test(name)) {
          offenders.push(`${name} (${why})`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every registered tool requires an allowed v1 verb', () => {
    for (const def of buildToolDefinitions(stubDeps())) {
      expect(ALLOWED_V1_VERBS.has(def.requiredVerb)).toBe(true);
    }
  });

  it('the registry REFUSES a forbidden tool name at registration (fail-closed)', () => {
    const endpoint = buildEndpoint({ verbs: [PermissionVerb.Read] });
    const client = new SpyScopedClient(endpoint.name);
    const fakeServer = {
      registerTool: (): void => undefined,
    } as unknown as McpServer;
    const forbidden: AnyToolDefinition = {
      name: 'invoke',
      requiredVerb: PermissionVerb.Read,
      title: 'raw passthrough',
      description: 'must never be registrable',
      inputSchema: {},
      outputSchema: {},
      handler: (): Promise<Result<ToolOutput, AppError>> =>
        Promise.resolve(err(appError(AppErrorCode.GatewayUnavailable, 'x'))),
    };
    expect(() =>
      new ToolRegistry().registerFor({
        server: fakeServer,
        definitions: [forbidden],
        contextProvider: (): Promise<Result<EndpointExecutionContext, AppError>> =>
          Promise.resolve(
            ok({
              endpoint,
              resolvedScope: resolvedScope(),
              overrides: new Map(),
              deniedVerbs: NO_DENIED,
              client,
            }),
          ),
      }),
    ).toThrow(/forbidden/i);
  });
});

// ---------------------------------------------------------------------------
// B. Data-layer reachability: forbidden MTProto request constructors in src/.
// ---------------------------------------------------------------------------

const SRC_ROOT = join(process.cwd(), 'src');

const walkTs = (dir: string): readonly string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walkTs(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
};

/**
 * GramJS request constructors that represent scope-mutation, account-global
 * mutation, or membership join/import. None may be constructed anywhere in src/.
 * (The folder resolver legitimately uses the READ method `messages.GetDialogFilters`,
 * which is deliberately NOT on this list.)
 */
const FORBIDDEN_MTPROTO: readonly { readonly pattern: RegExp; readonly capability: string }[] = [
  { pattern: /messages\.UpdateDialogFilter/, capability: 'folder/scope CRUD (messages.updateDialogFilter)' },
  { pattern: /account\.SetPrivacy/, capability: 'account-global privacy (account.setPrivacy)' },
  { pattern: /account\.UpdateProfile/, capability: 'account-global profile (account.updateProfile)' },
  { pattern: /channels\.EditAdmin/, capability: 'admin promotion (channels.editAdmin)' },
  { pattern: /channels\.EditBanned/, capability: 'ban/restrict (channels.editBanned)' },
  { pattern: /channels\.JoinChannel/, capability: 'channel join (channels.joinChannel)' },
  { pattern: /messages\.ImportChatInvite/, capability: 'invite import/join (messages.importChatInvite)' },
  { pattern: /messages\.AddChatUser/, capability: 'membership mutation (messages.addChatUser)' },
  { pattern: /photos\.(?:Upload|Update|Delete)/, capability: 'profile-photo mutation (photos.*)' },
];

describe('denylist guard — data-layer reachability (#2)', () => {
  it('no forbidden MTProto request constructor appears anywhere in src/', () => {
    const violations: string[] = [];
    for (const file of walkTs(SRC_ROOT)) {
      const text = readFileSync(file, 'utf8');
      const rel = relative(process.cwd(), file);
      for (const { pattern, capability } of FORBIDDEN_MTPROTO) {
        if (pattern.test(text)) {
          violations.push(`${rel}: ${capability}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
