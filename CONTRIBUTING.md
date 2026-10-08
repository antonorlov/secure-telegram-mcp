# Contributing

Thanks for helping improve secure-telegram-mcp.

## Setup

Node.js ≥ 20.10.

```bash
npm install
npm run ci     # typecheck + lint + architecture guard + knip + tests — must pass
npm run build
```

## Ground rules

- **Layering is enforced, not advisory.** Clean Architecture boundaries are
  checked by ESLint and `scripts/check-architecture.mjs`; GramJS is confined to
  `src/infrastructure`. The guard also rejects forbidden MCP surfaces and
  unreviewed MTProto request constructors — extend its review list deliberately,
  never work around it.
- **Security controls are features.** Anything listed under "Implemented
  controls" in [SECURITY.md](./SECURITY.md) must not be weakened by a change; if
  a trade-off is unavoidable, name it in the PR description.
- **Tests use synthetic data only.** Never commit real account names, chat ids,
  tokens, or session material — English synthetic fixtures only.
- **Commits** are one short conventional line (`fix: …`, `feat: …`, `chore: …`).

## Reporting security issues

Do not open a public issue for a vulnerability — use GitHub's private
vulnerability reporting (Security tab -> "Report a vulnerability"). See
[SECURITY.md](./SECURITY.md) for the threat model, what counts as in scope, and
disclosure expectations.
