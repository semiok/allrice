import { getWorkflowExecution } from '@allrice/database';

import { HandlerError } from '../errors.js';
import type { ClaimedJobHandlerInput } from '../job-runner.js';
import { buildAuthorizedKnowledgeContext } from '../knowledge.js';
import { executeDurableWorkflow } from '../workflow-engine.js';

export async function executeWorkflowRun({
  execution,
  workflowLease,
}: ClaimedJobHandlerInput) {
  if (execution.payload.type !== 'allrice.workflow.run') {
    throw new HandlerError(
      'UNSUPPORTED_JOB_TYPE',
      `Workflow handler cannot execute ${execution.payload.type}`,
      false,
    );
  }

  const workflow = await getWorkflowExecution({
    organizationId: execution.context.organizationId,
    workspaceId: execution.context.workspaceId!,
    runId: execution.context.runId,
  });
  return executeDurableWorkflow({
    execution,
    ...workflowLease,
    storageRoot: process.env.ALLRICE_STORAGE_ROOT ?? '.local/storage',
    executeStep: async ({ step, value }) => {
      if (step.kind !== 'knowledge') {
        throw new HandlerError(
          'WORKFLOW_CHAT_CONTEXT_REQUIRED',
          'Model, Skill and Tool workflow steps must start from an employee conversation',
          false,
        );
      }
      const configured = step.input.knowledgeRevisionIds;
      const knowledgeRevisionIds = Array.isArray(configured)
        ? configured.filter((item): item is string => typeof item === 'string')
        : [];
      const retrieved = await buildAuthorizedKnowledgeContext({
        context: execution.context,
        employeeId: workflow.employeeId,
        knowledgeRevisionIds,
        query:
          typeof step.input.query === 'string'
            ? step.input.query
            : JSON.stringify(value.workflowInput),
        storageRoot: process.env.ALLRICE_STORAGE_ROOT ?? '.local/storage',
      });
      return {
        output: {
          context: retrieved.context,
          citations: retrieved.citations,
        },
      };
    },
  });
}
