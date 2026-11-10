import type { AgentRuntime } from '#shared';
import { ClaudeCodeAdapter, type ClaudeCodeAdapterOptions } from './claude-code/adapter.js';
import type { AgentAdapter } from './contract.js';

export type AgentRegistry = Record<AgentRuntime, AgentAdapter>;

/** One adapter per supported agent runtime. A second runtime (M7) is added here. */
export function createAgentRegistry(
  options: { claudeCode?: ClaudeCodeAdapterOptions } = {},
): AgentRegistry {
  return { claude_code: new ClaudeCodeAdapter(options.claudeCode) };
}
