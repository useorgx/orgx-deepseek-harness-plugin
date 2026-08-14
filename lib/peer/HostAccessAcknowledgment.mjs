export const HOST_ACCESS_ACK_ENV = 'ORGX_DEEPSEEK_HOST_ACCESS_ACK';

export function requireHostAccessAcknowledgment(value) {
  if (value !== '1') {
    throw new TypeError(
      `${HOST_ACCESS_ACK_ENV}=1 is required: DeepSeek Harness workspace-write limits mutations but does not isolate same-user file reads, process visibility, or network access`
    );
  }
}
