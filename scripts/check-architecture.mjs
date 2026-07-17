#!/usr/bin/env node
/**
 * CI architecture / denylist guard — fails closed on boundary violations that
 * would weaken the security posture. Complements the ESLint boundary rules with
 * a coarse, dependency-free scan that also runs in CI.
 *
 * Layer-boundary rules (GramJS-only-in-infrastructure, inward dependency
 * direction) live in eslint.config.js `no-restricted-imports` and run via
 * `npm run lint` in CI. This script keeps only what ESLint cannot express:
 *
 * Rules:
 *  3. No tool named exactly 'invoke' / 'raw' (no raw MTProto method exposed).
 *  4. No scope-mutation tool names (set_scope / grant / revoke / add_chat ...).
 *  5. MTProto request constructors are ALLOW-LISTED (invariant #2): every
 *       `new Api.X(...)` in src/ must name a vetted read/addressing method —
 *       anything else (scope mutation, account-global mutation, membership
 *       join, contact mutation, ...) fails CLOSED, including methods this list
 *       has never heard of. Denylist evasion via aliasing/destructuring/
 *       computed access of `Api`, or via a non-constructor `.invoke(...)`
 *       argument, is refused by companion patterns.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');

/** @type {string[]} */
const violations = [];

/** @param {string} dir @returns {string[]} */
const walk = (dir) => {
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      // .tsx: the Ink setup wizard — scanned too, so the tool-name and
      // MTProto-constructor rules also hold for JSX modules.
      out.push(full);
    }
  }
  return out;
};

const importsFrom = (src, re) => re.test(src);

/**
 * The ONLY MTProto request/type constructors this product may instantiate —
 * vetted read/addressing methods plus the two inert argument types the send
 * paths build. Everything NOT on this list fails closed (an allow-list cannot
 * be evaded by a method the list omits — the failure mode of the previous
 * denylist, which e.g. never named contact mutation). High-level GramJS calls
 * (client.getMessages / sendMessage / ...) do not appear here: they carry no
 * `new Api.` constructor, and the forbidden-capability surface is what this
 * rule bounds.
 * @type {Set<string>}
 */
const ALLOWED_MTPROTO = new Set([
  'messages.GetDialogFilters', // folder resolution (READ)
  'messages.GetPeerDialogs', // bounded live dialog metadata refresh (READ)
  'channels.GetForumTopics', // forum-topic enumeration (READ)
  'messages.Search', // in-chat search (READ) — also pinned-message enumeration
  'messages.ReadDiscussion', // mark a forum/discussion thread read
  'messages.SaveDraft', // draft write (verb-gated tool)
  'messages.SendReaction', // reaction write (verb-gated `react` tool)
  'InputReplyToMessage', // inert argument type (topic addressing)
  'InputDialogPeer', // inert argument type (dialog-page addressing)
  'InputMessagesFilterEmpty', // inert argument type (search filter)
  'InputMessagesFilterPinned', // inert argument type (pinned-message filter)
  'ReactionEmoji', // inert argument type (a single standard-emoji reaction)
]);

/**
 * Evasion patterns for rule 5: with constructors allow-listed on the literal
 * `new Api.X(...)` form, any OTHER way of reaching a request class must be
 * refused wholesale in GramJS-importing files — aliasing, destructuring, or
 * computed access would let a forbidden constructor hide from the scan, and an
 * `.invoke()` argument that is not a direct `new Api.` expression could smuggle
 * a prebuilt request object in.
 * @type {{ pattern: RegExp; reason: string }[]}
 */
const API_EVASION = [
  { pattern: /\bApi\s*\[/, reason: "computed access on 'Api' (Api[...])" },
  { pattern: /\}\s*=\s*Api\b/, reason: "destructuring 'Api'" },
  { pattern: /=\s*Api\s*[;,)\n]/, reason: "aliasing 'Api'" },
  { pattern: /\bApi\s+as\s+/, reason: "renaming 'Api' on import" },
];

for (const file of walk(SRC)) {
  const rel = relative(ROOT, file).split('\\').join('/');
  const src = readFileSync(file, 'utf8');

  // Rules 3 & 4: forbidden tool names.
  for (const m of src.matchAll(/name:\s*['"]([a-z0-9_.-]+)['"]/g)) {
    const name = m[1];
    if (name === 'invoke' || name === 'raw') {
      violations.push(`${rel}: forbidden raw-MTProto tool name '${name}'`);
    }
    if (/^(set_scope|grant|revoke|add_chat|remove_chat|set_permissions)$/.test(name)) {
      violations.push(`${rel}: forbidden scope-mutation tool name '${name}'`);
    }
  }

  // Rule 5: MTProto constructor ALLOW-LIST (data-layer reachability).
  for (const m of src.matchAll(/new\s+Api\.([A-Za-z0-9_.]+)\s*\(/g)) {
    const ctor = m[1];
    if (!ALLOWED_MTPROTO.has(ctor)) {
      violations.push(
        `${rel}: MTProto constructor 'Api.${ctor}' is not on the vetted allow-list`,
      );
    }
  }
  // Rule 5 companions apply only where GramJS is reachable at all.
  if (importsFrom(src, /from ['"]telegram(\/|['"])/)) {
    for (const { pattern, reason } of API_EVASION) {
      if (pattern.test(src)) {
        violations.push(`${rel}: rule-5 evasion — ${reason}`);
      }
    }
    // Every low-level invoke must take a DIRECT `new Api.` constructor (checked
    // above), never a prebuilt/aliased request object.
    for (const m of src.matchAll(/\.invoke\(/g)) {
      const after = src.slice(m.index + m[0].length).replace(/^\s+/, '');
      if (!after.startsWith('new Api.')) {
        violations.push(
          `${rel}: .invoke(...) argument is not a direct 'new Api.' constructor`,
        );
      }
    }
  }
}

if (violations.length > 0) {
  console.error('Architecture guard FAILED:');
  for (const v of violations) {
    console.error(`  - ${v}`);
  }
  process.exit(1);
}
console.error('Architecture guard passed.');
