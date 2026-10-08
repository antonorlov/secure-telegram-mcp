/**
 * Where the one local daemon listens and every `connect` shim finds it: on macOS and Linux a
 * UNIX socket inside the 0700 session dir, where file permissions are the access boundary —
 * stronger than loopback TCP — and a named pipe on Windows.
 */
import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// Conservative ceiling under the kernel sun_path limit (104/108 bytes).
const MAX_UNIX_SOCKET_PATH = 96;

const shortHash = (input: string): string =>
  createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 12);

export const daemonAddress = (sessionDir: string): string => {
  const abs = resolve(sessionDir);
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\secure-telegram-mcp-${shortHash(abs)}`;
  }
  const inDir = join(abs, 'daemon.sock');
  // When the session dir path is too long for sun_path, fall back to a dedicated per-store
  // subdir, so the parent is 0700-ownable rather than the shared 1777 tmpdir.
  return inDir.length <= MAX_UNIX_SOCKET_PATH
    ? inDir
    : join(tmpdir(), `secure-telegram-mcp-${shortHash(abs)}`, 'daemon.sock');
};

// Separate operator protocol address; never parsed by the MCP listener.
export const operatorAddress = (sessionDir: string): string => {
  const daemon = daemonAddress(sessionDir);
  return isSocketFile(daemon)
    ? join(dirname(daemon), 'operator.sock')
    : `${daemon}-operator`;
};

export const isSocketFile = (address: string): boolean =>
  !address.startsWith('\\\\.\\pipe\\');

/**
 * The directory holding a unix socket is the socket's true access boundary: verify it is a real
 * directory owned by THIS user with no group or other access. Defeats a shared-host squat where
 * another local user pre-creates the predictable path.
 */
export const socketDirRefusal = async (
  address: string,
): Promise<string | null> => {
  if (!isSocketFile(address)) {
    return null; // named pipe — not a filesystem path
  }
  const dir = dirname(address);
  let st;
  try {
    st = await lstat(dir);
  } catch {
    return `socket directory ${dir} is missing`;
  }
  if (!st.isDirectory()) {
    return `socket directory ${dir} is not a directory`;
  }
  const uid =
    typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (uid !== undefined && st.uid !== uid) {
    return `socket directory ${dir} is not owned by this user`;
  }
  if ((st.mode & 0o077) !== 0) {
    return `socket directory ${dir} is group/other-accessible`;
  }
  return null;
};
