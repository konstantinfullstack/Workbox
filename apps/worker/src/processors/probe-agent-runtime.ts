import { probeClaudeCode } from '#integrations';
import { probeAgentRuntimeJobDataSchema, type ProbeAgentRuntimeJobResult } from '#shared';

export interface ProbeOptions {
  /** CLAUDE_CODE_COMMAND: override the `claude` executable (path or name). */
  claudeCommand?: string | undefined;
}

/** Runs where agents run, so it reflects what this machine can actually execute. */
export async function processProbeAgentRuntime(
  data: unknown,
  workerId: string,
  options: ProbeOptions = {},
): Promise<ProbeAgentRuntimeJobResult> {
  probeAgentRuntimeJobDataSchema.parse(data);
  const result = await probeClaudeCode(
    options.claudeCommand ? { command: options.claudeCommand } : {},
  );
  return { ...result, workerId, checkedAt: new Date().toISOString() };
}
