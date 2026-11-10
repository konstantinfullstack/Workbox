import type { Database } from '#database';
import { createCodeHostRegistry, type CodeHostRegistry } from '#integrations';
import type { Keyring } from '#vault';
import { AgentRuntimeService, type WorkerGateway } from './agent-runtime-service.js';
import { ConnectionService } from './connection-service.js';
import { ProjectService } from './project-service.js';
import { RepositoryService } from './repository-service.js';
import { RunService } from './run-service.js';
import { TaskService } from './task-service.js';

export { AgentRuntimeService, type WorkerGateway } from './agent-runtime-service.js';
export { ConnectionService, credentialContext } from './connection-service.js';
export type { ActionContext } from './context.js';
export { ProjectService } from './project-service.js';
export { RepositoryService } from './repository-service.js';
export { RunExecutor, type RunExecutorOptions } from './run-executor.js';
export { RUNNABLE_TASK_STATES, RunService } from './run-service.js';
export { transitionTaskInTx } from './task-service.js';
export { TaskService } from './task-service.js';
export {
  WorkspaceSyncer,
  type SyncOutcome,
  type WorkspaceSyncerOptions,
} from './workspace-syncer.js';
export { rotateCredentialKeys, type RotationSummary } from './vault-rotation.js';

export interface Services {
  projects: ProjectService;
  tasks: TaskService;
  connections: ConnectionService;
  repositories: RepositoryService;
  agentRuntimes: AgentRuntimeService;
  runs: RunService;
}

export interface ServiceDeps {
  db: Database;
  keyring: Keyring;
  codeHosts?: CodeHostRegistry;
  workerGateway?: WorkerGateway;
  now?: () => Date;
}

export function createServices(deps: ServiceDeps): Services {
  const codeHosts = deps.codeHosts ?? createCodeHostRegistry();
  const connections = new ConnectionService({
    db: deps.db,
    keyring: deps.keyring,
    codeHosts,
    ...(deps.now ? { now: deps.now } : {}),
  });
  return {
    projects: new ProjectService(deps.db),
    tasks: new TaskService(deps.db),
    connections,
    repositories: new RepositoryService(deps.db, codeHosts, connections, deps.workerGateway),
    agentRuntimes: new AgentRuntimeService(deps.db, deps.workerGateway),
    runs: new RunService(deps.db, deps.workerGateway),
  };
}
