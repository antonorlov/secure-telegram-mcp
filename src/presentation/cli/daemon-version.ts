/**
 * The daemon is detached and outlives the CLI that started it, so upgrading the package does not
 * upgrade the process already serving MCP clients. The operator is told, with the way out.
 */
import { PACKAGE_VERSION } from '../../infrastructure/package-info.js';

export const daemonVersionWarning = (
  daemonVersion: string,
  cliVersion: string = PACKAGE_VERSION,
): string | undefined =>
  daemonVersion === cliVersion
    ? undefined
    : `Telegram MCP ${daemonVersion} is running, but this CLI is ${cliVersion}. ` +
      "To switch, run 'npx secure-telegram-mcp stop', then 'start' again.";
