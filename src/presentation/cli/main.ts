/**
 * CLI entrypoint / bin dispatcher. `setup` is an operator UI, `connect` is the
 * stdio shim, and the hidden daemon worker is the sole Telegram owner. A
 * thin composition shell — reads operator-supplied, out-of-band configuration from the
 * environment (never from the model) and hands fully-formed options to each flow.
 *
 * Never write protocol-irrelevant output to STDOUT; stdout is reserved for the
 * MCP stdio transport on `connect`. Diagnostics go to STDERR.
 */
import {
  defaultConfigPath,
  defaultMediaDir,
  defaultSessionDir,
} from '../../infrastructure/app-home.js';
import {
  MAX_PASSPHRASE_FILE_BYTES,
  readRegularFileBounded,
  readUtf8Bounded,
} from '../../infrastructure/bounded-read.js';
import { ENDPOINT_TOKEN_ENV } from '../../infrastructure/endpoint-token.js';
import type { SessionKeySource } from '../../application/index.js';
import { isErr, type Result } from '../../shared/index.js';
import type { DaemonCommand } from '../daemon-socket.js';
import type { OperatorClient } from '../operator/client.js';
import {
  parseApiId,
  parseApiHash,
  CREDENTIALS_URL,
} from './credential-prompter.js';

const USAGE = `npx secure-telegram-mcp <command>

Commands:
  setup    Configure Telegram login, endpoints, and session security
  start    Start Telegram MCP, show its status, or unlock it
  apply    Validate and apply config.json (PIN-protected installs need an unlock secret)
  connect  Connect an MCP client (starts Telegram MCP automatically)

Telegram app credentials (from ${CREDENTIALS_URL}):
  TELEGRAM_API_ID            OPTIONAL. 'setup' PROMPTS for these interactively
  TELEGRAM_API_HASH          (api_hash echo-off) — no need to export them and
                             leak them into shell history; when set they are used
                             as a pre-fill default. For Telegram MCP they are OPTIONAL
                             overrides of the credentials sealed into the session
                             at setup (the sealed values are SSOT).

Session unlock (OPTIONAL; first present wins). When none is set the
machine-bound key is used (SMOOTH posture); supplying a PIN selects the
HARDENED posture:
  TELEGRAM_MCP_SESSION_PASSPHRASE_FILE  Path to a 0600 file holding the PIN
  TELEGRAM_MCP_SESSION_PASSPHRASE       The PIN inline (*_FILE is preferred)
  TELEGRAM_MCP_SESSION_KEYFILE          Recovery keyfile for data present when it was exported

Optional environment:
  TELEGRAM_MCP_CONFIG        Config draft path (default: ~/.secure-telegram-mcp/config.json)
  TELEGRAM_MCP_SESSION_DIR   Encrypted session directory (default: ~/.secure-telegram-mcp/sessions)
  TELEGRAM_MCP_AUDIT_LOG     Audit log path (default: <session-dir>/audit.log)
  TELEGRAM_MCP_MEDIA_DIR     Shared media root (default: ~/.secure-telegram-mcp/media)
  TELEGRAM_MCP_IDLE_HOURS    PIN-protected idle auto-lock window (default: 12; 0 disables)
  TELEGRAM_MCP_ENDPOINT      Optional endpoint-name assertion (the token selects it)
  TELEGRAM_MCP_DEBUG_LOG     Owner-only setup diagnostic log (error messages are omitted)
  ${ENDPOINT_TOKEN_ENV}  The endpoint's API key (required to connect)
`;

/** An env var is "present" when defined at all — even empty (empty != unset). */
const present = (name: string): string | undefined => process.env[name];

/** Strip a single trailing newline (the documented *_FILE write convention). */
const stripTrailingNewline = (value: string): string =>
  value.replace(/\r?\n$/, '');

/**
 * Read a passphrase from a 0600 *_FILE: the file contents are the secret. The trailing
 * newline most editors/`echo` add is stripped; an empty/whitespace result is rejected
 * (an empty file is a misconfiguration, never "unset").
 */
const readPassphraseFile = async (
  name: string,
  filePath: string,
): Promise<string> => {
  if (filePath.trim().length === 0) {
    throw new Error(`environment variable ${name} is set but empty`);
  }
  let bytes: Buffer | undefined;
  let contents: string;
  try {
    bytes = await readRegularFileBounded(filePath, MAX_PASSPHRASE_FILE_BYTES);
    contents = bytes.toString('utf8');
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`could not read ${name} '${filePath}': ${reason}`);
  } finally {
    bytes?.fill(0);
  }
  const passphrase = stripTrailingNewline(contents);
  if (passphrase.trim().length === 0) {
    throw new Error(`${name} '${filePath}' is empty`);
  }
  return passphrase;
};

/**
 * Resolve the out-of-band session unlock material from the environment.
 *
 * Returns `undefined` when no unlock channel is supplied (the caller falls back to the
 * machine-bound key — SMOOTH posture). Channel precedence, highest first: PASSPHRASE_FILE
 * -> PASSPHRASE -> KEYFILE. A channel that is present but empty/whitespace is fail-closed
 * (rejected), never treated as unset — no silent fall-through to the machine key.
 */
const sessionKeyFromEnv = async (): Promise<SessionKeySource | undefined> => {
  const passFile = present('TELEGRAM_MCP_SESSION_PASSPHRASE_FILE');
  if (passFile !== undefined) {
    const passphrase = await readPassphraseFile(
      'TELEGRAM_MCP_SESSION_PASSPHRASE_FILE',
      passFile,
    );
    return { kind: 'passphrase', passphrase };
  }

  const passphrase = present('TELEGRAM_MCP_SESSION_PASSPHRASE');
  if (passphrase !== undefined) {
    if (passphrase.trim().length === 0) {
      throw new Error(
        'environment variable TELEGRAM_MCP_SESSION_PASSPHRASE is set but empty',
      );
    }
    return { kind: 'passphrase', passphrase };
  }

  const keyfilePath = present('TELEGRAM_MCP_SESSION_KEYFILE');
  if (keyfilePath !== undefined) {
    if (keyfilePath.trim().length === 0) {
      throw new Error(
        'environment variable TELEGRAM_MCP_SESSION_KEYFILE is set but empty',
      );
    }
    return { kind: 'keyfile', keyfilePath };
  }

  return undefined;
};

/**
 * Read an optional Telegram app credential (api_id/api_hash) from the environment,
 * validated by the shared setup-prompt parser. `undefined` when unset/empty (the sealed
 * session is the source of truth).
 *
 * `strict` splits the two consumers on a present-but-malformed value (incl.
 * whitespace-only — the same trim/reject rule the passphrase channel enforces):
 * - daemon reads STRICT: the value overrides the sealed creds, so a bad override
 *   (`TELEGRAM_API_HASH="   "`) is rejected loud — a fail-closed misconfiguration.
 * - setup reads SOFT (pre-fill only): setup re-validates at the prompt, so a malformed
 *   or stale value is ignored and the operator is prompted — a leftover/typo'd
 *   `export TELEGRAM_API_HASH=...` never blocks onboarding.
 */
const readApiEnv = <T>(
  name: string,
  parse: (raw: string) => Result<T, string>,
  strict: boolean,
): T | undefined => {
  const raw = present(name);
  if (raw === undefined || raw.length === 0) {
    return undefined;
  }
  const parsed = parse(raw);
  if (isErr(parsed)) {
    if (strict) {
      throw new Error(`environment variable ${name} is invalid: ${parsed.error}`);
    }
    return undefined;
  }
  return parsed.value;
};

const main = async (argv: readonly string[]): Promise<void> => {
  const command = argv[2];
  const configPath =
    process.env['TELEGRAM_MCP_CONFIG'] ?? defaultConfigPath();
  const sessionDir = process.env['TELEGRAM_MCP_SESSION_DIR'] ?? defaultSessionDir();
  const auditLogPath =
    process.env['TELEGRAM_MCP_AUDIT_LOG'] ?? `${sessionDir}/audit.log`;
  const mediaRootDir =
    process.env['TELEGRAM_MCP_MEDIA_DIR'] ?? defaultMediaDir();
  const endpointName = process.env['TELEGRAM_MCP_ENDPOINT'];
  const endpointToken = process.env[ENDPOINT_TOKEN_ENV];
  const daemonCommand = (): DaemonCommand => {
    const entry = argv[1];
    if (entry === undefined) {
      throw new Error('cannot determine the CLI entrypoint to start Telegram MCP');
    }
    return {
      execPath: process.execPath,
      args: [entry, 'start', '--worker'],
    };
  };
  const operatorClient = async (): Promise<OperatorClient> => {
    const { OperatorClient: Client } = await import('../operator/client.js');
    return new Client({ sessionDir, daemonCommand: daemonCommand() });
  };

  switch (command) {
    case 'setup': {
      const { runSetup } = await import('./setup.js');
      // Setup mints the sealed session. api creds are acquired interactively by runSetup
      // (api_hash echo-off) so they never have to be `export`ed into shell history; any env
      // value is passed as an optional pre-fill only. The interactive PIN prompt is
      // likewise owned by runSetup, so with no unlock channel we pass the machine default.
      // Pre-fill reads are soft: a malformed/stale export is ignored (the prompter re-validates).
      const apiIdPrefill = readApiEnv('TELEGRAM_API_ID', parseApiId, false);
      const apiHashPrefill = readApiEnv('TELEGRAM_API_HASH', parseApiHash, false);
      await runSetup({
        configPath,
        sessionDir,
        ...(apiIdPrefill !== undefined ? { apiId: apiIdPrefill } : {}),
        ...(apiHashPrefill !== undefined ? { apiHash: apiHashPrefill } : {}),
        sessionKey: (await sessionKeyFromEnv()) ?? { kind: 'machine' },
        operatorClient: await operatorClient(),
      });
      return;
    }
    case 'connect': {
      // The thin shim MCP clients spawn: no Telegram inside — it finds (or
      // detaches-and-starts) the one daemon and pipes stdio <-> socket.
      const { connect } = await import('../mcp/connect.js');
      // connect always establishes: a locked daemon still serves (tools/list works; calls
      // return the secret-free lock error until `npx secure-telegram-mcp start`
      // unlock). No preflight/refusal here.
      await connect({
        sessionDir,
        ...(endpointToken !== undefined ? { endpointToken } : {}),
        ...(endpointName !== undefined ? { endpointName } : {}),
        daemonCommand: daemonCommand(),
      });
      return;
    }
    case 'start': {
      // The public command is an operator action. The internal worker is the only
      // process role that constructs the Telegram runtime; setup/connect spawn it
      // detached with this explicit flag.
      if (!argv.includes('--worker')) {
        const operator = await operatorClient();
        try {
          const connected = await operator.connect();
          if (isErr(connected)) throw new Error(connected.error);
          const status = await operator.status();
          if (isErr(status)) throw new Error(status.error);
          if (status.value.posture === 'hardened' && status.value.locked) {
            const { promptPin } = await import('./pin-prompt.js');
            for (let attempt = 1; attempt <= 3; attempt += 1) {
              const pin = await promptPin('PIN: ', {
                input: process.stdin,
                output: process.stderr,
              });
              if (pin === undefined) {
                process.exitCode = 1;
                return;
              }
              const authenticated = await operator.authenticate({
                kind: 'passphrase',
                passphrase: pin,
              });
              if (!isErr(authenticated)) {
                process.stderr.write('Telegram MCP is unlocked and running.\n');
                return;
              }
              process.stderr.write('Wrong PIN or temporarily rate-limited.\n');
            }
            process.stderr.write('Too many attempts.\n');
            process.exitCode = 1;
            return;
          }
          process.stderr.write(
            status.value.posture === 'none'
              ? 'Telegram MCP is running. Continue with setup.\n'
              : 'Telegram MCP is running.\n',
          );
        } finally {
          operator.close();
        }
        return;
      }

      // The one long-lived owner of every Telegram connection. Detached workers
      // write diagnostics to the protected session directory.
      const apiIdOverride = readApiEnv('TELEGRAM_API_ID', parseApiId, true);
      const apiHashOverride = readApiEnv('TELEGRAM_API_HASH', parseApiHash, true);
      const [
        { daemon },
        { FileConfigRepository },
        { SealedPolicyRepository },
      ] = await Promise.all([
        import('../mcp/daemon.js'),
        import('../../infrastructure/config/file-config-repository.js'),
        import('../../infrastructure/config/sealed-policy-repository.js'),
      ]);

      const fs = await import('node:fs');
      const path = await import('node:path');
      fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
      const logPath = path.join(sessionDir, 'telegram-mcp.log');
      const logger = (message: string): void => {
        try {
          fs.appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`, {
            mode: 0o600,
          });
        } catch {
          /* logging must never take the daemon down */
        }
      };
      const daemonKey: SessionKeySource =
        (await sessionKeyFromEnv()) ?? { kind: 'machine' };
      const daemonConfig = new FileConfigRepository({ filePath: configPath });
      await daemon({
        // Verify-before-use, re-keyable at runtime unlock: the enforced repo is bound to the
        // daemon's one shared store and opens the sealed policy before execution.
        // `plainConfigRepository` renders the locked-window tool-name menu from the draft only.
        makeConfigRepository: (store) =>
          new SealedPolicyRepository({
            configPath,
            parser: daemonConfig,
            store,
          }),
        plainConfigRepository: daemonConfig,
        configParser: daemonConfig,
        ...(apiIdOverride !== undefined ? { apiId: apiIdOverride } : {}),
        ...(apiHashOverride !== undefined ? { apiHash: apiHashOverride } : {}),
        sessionDir,
        sessionKey: daemonKey,
        auditLogPath,
        mediaRootDir,
        logger,
      });
      return;
    }
    case 'apply': {
      const applyKey: SessionKeySource =
        (await sessionKeyFromEnv()) ?? { kind: 'machine' };
      const operator = await operatorClient();
      try {
        const connected = await operator.connect();
        if (isErr(connected)) throw new Error(connected.error);
        const authenticated = await operator.authenticate(applyKey);
        if (isErr(authenticated)) throw new Error(authenticated.error);
        const raw = await readUtf8Bounded(configPath);
        const applied = await operator.applyPolicy(raw);
        if (isErr(applied)) throw new Error(applied.error);
        process.stderr.write(
          `Config applied live (${applied.value.digest.slice(0, 12)}).\n`,
        );
      } finally {
        operator.close();
      }
      return;
    }
    default:
      process.stderr.write(USAGE);
      process.exitCode = 1;
      return;
  }
};

main(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`error: ${message}\n`);
  process.exitCode = 1;
});
