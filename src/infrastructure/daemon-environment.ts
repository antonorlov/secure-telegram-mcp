import { ENDPOINT_TOKEN_ENV } from './endpoint-token.js';

/** A daemon inherits runtime configuration, never one MCP client's authority. */
export const daemonSpawnEnvironment = (
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv => {
  const {
    [ENDPOINT_TOKEN_ENV]: endpointToken,
    TELEGRAM_MCP_ENDPOINT: endpointName,
    ...environment
  } = source;
  void endpointToken;
  void endpointName;
  return environment;
};
