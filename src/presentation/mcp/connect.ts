/**
 * connect — the thin shim every MCP client spawns (its stdio "server"). It owns no Telegram
 * state: it finds the one local daemon at `daemonAddress`, auto-starts it (detached,
 * gpg-agent style) when absent, sends the one-line handshake (endpoint API key / name), then
 * pipes stdio ⇄ socket verbatim. Ten shims are ten pipes into one daemon — the safe shape for
 * Telegram's one-owner-per-auth-key rule.
 *
 * Detached daemon: spawned with the same entrypoint + env (`start --worker`), stdio ignored
 * (it logs to its file), unref'd so this shim's exit never kills it. The daemon binds the
 * socket; this shim polls until it answers.
 *
 * Locked but serving: connect always establishes an MCP session — even when the session is
 * PIN-locked. A locked daemon still binds and serves (initialize + tools/list succeed); each
 * tool call returns a secret-free lock error until `npx secure-telegram-mcp start`
 * unlock. This shim owns zero lock knowledge: it is a pure byte pipe with no preflight/refusal.
 */
import { daemonAddress } from '../../infrastructure/daemon-address.js';
import { isErr } from '../../shared/index.js';
import {
  openDaemonSocket,
  type DaemonCommand,
} from '../daemon-socket.js';

export interface ConnectOptions {
  /** Session dir — keys the rendezvous address (must match the daemon's). */
  readonly sessionDir: string;
  /** The required endpoint API key and an optional matching-name assertion. */
  readonly endpointToken?: string;
  readonly endpointName?: string;
  /** How the daemon is spawned when absent (argv without the command word). */
  readonly daemonCommand: DaemonCommand;
}

export const connect = async (options: ConnectOptions): Promise<void> => {
  const address = daemonAddress(options.sessionDir);
  const opened = await openDaemonSocket({
    address,
    daemonCommand: options.daemonCommand,
    unavailableError:
      'Telegram MCP did not start; check telegram-mcp.log in the session directory',
  });
  if (isErr(opened)) {
    process.stderr.write(`[secure-telegram-mcp][connect] ${opened.error}\n`);
    process.exitCode = 1;
    return;
  }
  const socket = opened.value;

  // Handshake first (ordering on the stream is guaranteed), then raw piping — the MCP client
  // on our stdio and the daemon speak newline-delimited JSON-RPC through us without this shim
  // ever parsing a message.
  socket.write(
    `${JSON.stringify({
      v: 1,
      ...(options.endpointToken !== undefined ? { token: options.endpointToken } : {}),
      ...(options.endpointName !== undefined ? { endpoint: options.endpointName } : {}),
    })}\n`,
  );
  await new Promise<void>((resolve) => {
    let failed = false;
    let inputEnded = false;
    const onSocketError = (): void => {
      failed = true;
    };
    const onInputError = (): void => {
      failed = true;
      socket.destroy();
    };
    const onInputEnd = (): void => {
      inputEnded = true;
      socket.end();
    };
    const onClose = (): void => {
      process.stdin.unpipe(socket);
      socket.unpipe(process.stdout);
      process.stdin.pause();
      process.stdin.off('end', onInputEnd);
      process.stdin.off('error', onInputError);
      socket.off('error', onSocketError);
      if (failed || !inputEnded) process.exitCode = 1;
      resolve();
    };
    socket.once('error', onSocketError);
    socket.once('close', onClose);
    process.stdin.once('error', onInputError);
    if (process.stdin.readableEnded) {
      onInputEnd();
    } else {
      process.stdin.once('end', onInputEnd);
      process.stdin.pipe(socket);
    }
    // stdout belongs to the parent MCP client; never close it from the shim.
    socket.pipe(process.stdout, { end: false });
  });
};
