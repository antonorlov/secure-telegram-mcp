/**
 * Daemon RENDEZVOUS ADDRESS — where the one local daemon listens and where every
 * `connect` shim finds it (gpg-agent style):
 *  - macOS/Linux: a UNIX SOCKET inside the 0700 session dir (file permissions
 *    are the access boundary — stronger than loopback TCP), falling back to a
 *    hashed path in the tmpdir when the dir path would exceed the OS's
 *    ~104-byte sun_path limit;
 *  - Windows: a NAMED PIPE whose name is derived from the session dir (pipes
 *    are kernel objects, not files — per-user by default).
 * Keyed on the RESOLVED session dir so different stores get different daemons.
 */
import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** Conservative ceiling under the kernel sun_path limit (104/108 bytes). */
const MAX_UNIX_SOCKET_PATH = 96;

const shortHash = (input: string): string =>
  createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 12);

/** The daemon's listen/connect address for a given session dir. */
export const daemonAddress = (sessionDir: string): string => {
  const abs = resolve(sessionDir);
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\secure-telegram-mcp-${shortHash(abs)}`;
  }
  const inDir = join(abs, 'daemon.sock');
  // Fallback (session dir path too long for sun_path): a DEDICATED per-store
  // subdir so its parent is 0700-ownable (the socket's access boundary is the
  // directory's perms, not the shared 1777 tmpdir + umask).
  return inDir.length <= MAX_UNIX_SOCKET_PATH
    ? inDir
    : join(tmpdir(), `secure-telegram-mcp-${shortHash(abs)}`, 'daemon.sock');
};

/** Separate operator protocol address; never parsed by the MCP listener. */
export const operatorAddress = (sessionDir: string): string => {
  const daemon = daemonAddress(sessionDir);
  return isSocketFile(daemon)
    ? join(dirname(daemon), 'operator.sock')
    : `${daemon}-operator`;
};

/** True when the address is a filesystem path (unix socket) vs a named pipe. */
export const isSocketFile = (address: string): boolean =>
  !address.startsWith('\\\\.\\pipe\\');

/**
 * Verify the directory that HOLDS a unix socket is a real directory owned by
 * THIS user with no group/other access (mode & 0o077 === 0) — the socket's true
 * access boundary. Defeats a shared-host squat where another local user
 * pre-creates the predictable tmpdir-fallback dir and binds a rogue socket (the
 * daemon's `mkdir(mode:0700)` is a NO-OP on an existing dir). Returns a refusal
 * reason, or null when safe. No-op for Windows named pipes (kernel per-user).
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
