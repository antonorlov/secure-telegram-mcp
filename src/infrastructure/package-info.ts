// The package's own version, read from the package.json that ships beside `dist/`. One source,
// so what an MCP client is told in `initialize` can never drift from what npm published.
import { readFileSync } from 'node:fs';

// `../../package.json` from both `src/infrastructure/` and `dist/infrastructure/`: the same
// package root in a checkout and in an installed tarball.
const readPackageVersion = (): string => {
  const parsed: unknown = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  );
  const version =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as { readonly version?: unknown }).version
      : undefined;
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error('package.json carries no version');
  }
  return version;
};

export const PACKAGE_VERSION: string = readPackageVersion();
