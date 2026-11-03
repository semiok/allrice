import {
  publicModelFailureMessage,
  type WorkflowRun,
} from '@allrice/contracts';

/** Only the public error slot is mapped; workflow execution and business output
 * retain their existing semantics. */
export function publicWorkflowRun(run: WorkflowRun): WorkflowRun {
  return {
    ...run,
    steps: run.steps.map((step) => ({
      ...step,
      errorMessage: publicModelFailureMessage(
        step.errorCode,
        step.errorMessage,
        run.runId,
      ),
    })),
  };
}
