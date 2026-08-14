import {
  HOST_ACCESS_ACK_ENV,
  requireHostAccessAcknowledgment,
} from './HostAccessAcknowledgment.mjs';
import { rejectManagedRunnerOptions, startPeer } from './peer.mjs';

export async function main(env = process.env, deps = {}) {
  const apiKey = env.ORGX_API_KEY;
  const mcpAccessToken = env.ORGX_MCP_ACCESS_TOKEN;
  const deepSeekApiKey = env.DEEPSEEK_API_KEY;
  const workspaceId = env.ORGX_WORKSPACE_ID;
  const installationId = env.ORGX_INSTALLATION_ID;
  const activationAttemptId = env.ORGX_ACTIVATION_ATTEMPT_ID;
  const runnerRole = env.ORGX_RUNNER_ROLE;
  const runnerInstanceId = env.ORGX_RUNNER_INSTANCE_ID;
  const workspaceRoot = env.ORGX_WORKSPACE_ROOT;
  if (
    !apiKey ||
    !mcpAccessToken ||
    !deepSeekApiKey ||
    !workspaceId ||
    !installationId ||
    !workspaceRoot
  ) {
    throw new Error(
      'ORGX_API_KEY, ORGX_MCP_ACCESS_TOKEN, DEEPSEEK_API_KEY, ORGX_WORKSPACE_ID, ORGX_INSTALLATION_ID, and ORGX_WORKSPACE_ROOT are required'
    );
  }
  requireHostAccessAcknowledgment(env[HOST_ACCESS_ACK_ENV]);
  rejectManagedRunnerOptions({
    activationAttemptId,
    runnerRole,
    runnerInstanceId,
  });

  const peer = await (deps.startPeer ?? startPeer)({
    apiKey,
    workspaceId,
    installationId,
    baseUrl: env.ORGX_BASE_URL ?? 'https://useorgx.com',
    workspaceRoot,
    bin: env.ORGX_DEEPSEEK_HARNESS_BIN,
    profile: env.ORGX_DEEPSEEK_HARNESS_PROFILE,
    model: env.ORGX_DEEPSEEK_HARNESS_MODEL,
    hostAccessAck: env[HOST_ACCESS_ACK_ENV],
    env,
  });
  (deps.logger ?? console).log(
    '[orgx-deepseek-harness] peer running. Press Ctrl-C to stop.'
  );

  if (deps.registerSignals !== false) {
    let stopping = false;
    const shutdown = async () => {
      if (stopping) return;
      stopping = true;
      await peer.stop();
      process.exitCode = 0;
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }
  return peer;
}
