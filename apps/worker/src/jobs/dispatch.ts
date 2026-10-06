import { HandlerError } from '../errors.js';
import type {
  ClaimedJobHandler,
  ClaimedJobHandlerInput,
} from '../job-runner.js';
import { executeEmployeeRun } from './employee-run.js';
import { executePlatformTechnicalTask } from './platform-technical.js';
import { executePlatformRepositoryAction } from './platform-repository.js';
import { executePlatformRepositoryMerge } from './platform-repository-merge.js';
import { executeSystemEcho } from './system-echo.js';
import { executeWorkflowRun } from './workflow-run.js';

const handlers = {
  'allrice.employee.run': executeEmployeeRun,
  'allrice.platform.technical': executePlatformTechnicalTask,
  'allrice.platform.repository': executePlatformRepositoryAction,
  'allrice.platform.repository.merge': executePlatformRepositoryMerge,
  'allrice.system.echo': executeSystemEcho,
  'allrice.workflow.run': executeWorkflowRun,
} satisfies Record<string, ClaimedJobHandler>;

export function resolveJobHandler(payloadType: string): ClaimedJobHandler {
  const handler = handlers[payloadType as keyof typeof handlers];
  if (!handler) {
    throw new HandlerError(
      'UNSUPPORTED_JOB_TYPE',
      `No Worker handler is registered for ${payloadType}`,
      false,
    );
  }
  return handler;
}

export function executeDispatchedJob(input: ClaimedJobHandlerInput) {
  return resolveJobHandler(input.execution.payload.type)(input);
}
