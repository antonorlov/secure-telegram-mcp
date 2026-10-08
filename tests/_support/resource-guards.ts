/**
 * The process-level proof that a socket suite cleaned up after itself. Removing a socket path
 * or counting signal handlers says nothing about a server still accepting connections, so the
 * handle table is the last word.
 */
import { afterAll, beforeAll, expect } from 'vitest';
import { Server } from 'node:net';

export const listeningServers = (): Server[] => {
  const handles = (
    process as NodeJS.Process & { _getActiveHandles?: () => unknown[] }
  )._getActiveHandles?.();
  return (handles ?? []).filter(
    (handle): handle is Server => handle instanceof Server && handle.listening,
  );
};

const signalCount = (): number =>
  process.listenerCount('SIGINT') + process.listenerCount('SIGTERM');

/**
 * Call at the top of a describe that starts daemons: a daemon outliving its case keeps two
 * listening sockets and a one-shot signal handler alive, and a green run that leaks them is
 * only reporting that the worker exited.
 */
export const guardProcessResources = (): void => {
  let signalBaseline = 0;
  beforeAll(() => {
    signalBaseline = signalCount();
  });
  afterAll(() => {
    expect(signalCount(), 'signal handlers left behind').toBe(signalBaseline);
    expect(listeningServers(), 'servers left listening').toEqual([]);
  });
};
