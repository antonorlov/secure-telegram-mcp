/**
 * The thin shim every MCP client spawns. It owns no Telegram state: it finds the one local
 * daemon at `daemonAddress`, auto-starts it detached when absent, sends the one-line handshake,
 * then pipes stdio to the socket.
 */
import { daemonAddress } from '../../infrastructure/daemon-address.js';
import { isErr } from '../../shared/index.js';
import {
  openDaemonSocket,
  type DaemonCommand,
} from '../daemon-socket.js';

export interface ConnectOptions {
  readonly sessionDir: string;
  readonly endpointToken?: string;
  readonly endpointName?: string;
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

  /**
   * Handshake first — ordering on the stream is guaranteed — then raw piping: the MCP client
   * and the daemon speak newline-delimited JSON-RPC through this shim without it ever parsing a
   * message.
   */
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
