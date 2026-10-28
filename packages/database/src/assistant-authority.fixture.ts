/** Legacy assistant admission layered on the generic Run identity fixture. */
import type { RuntimePolicyControls } from '@allrice/contracts';
import { createRunAuthorityFixture } from './run-authority.fixture.ts';
import {
  assistantFixture,
  type createAssistantFixtureDatabase,
} from './assistant-runtime.fixture.ts';
import {
  createAssistantRuntime,
  type AssistantAuthorityInput,
} from './assistant-runtime.ts';
import { assertAssistantAuthority } from './assistant-authority.ts';
import { updateWorkAutomation } from './work-automation.ts';
export async function createAssistantAuthorityFixture(
  db: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>['db'],
  options: Parameters<typeof createRunAuthorityFixture>[1] = {},
) {
  const selectedTools = options.allowedTools ?? [
    'assistant.delegate',
    'assistant.report',
    'web.fetch',
  ];
  const base = await assistantFixture(db, 12, {
    nativeSessionId: options.nativeSessionId,
  });
  const identity = await createRunAuthorityFixture(
    db,
    {
      ...options,
      allowedTools: selectedTools,
      controls:
        options.controls === undefined
          ? ({
              version: 1,
              enabled: true,
              mode: 'execute',
              rules: [{ action: 'assistant.delegate', effect: 'allow' }],
            } as RuntimePolicyControls)
          : options.controls,
    },
    base,
  );
  const { task, rootRunId, workspace } = identity;
  await db.begin(async (tx) => {
    await tx`delete from allrice_assistant_instances where root_run_id=${rootRunId}`;
    await tx`delete from allrice_assistant_roots where root_run_id=${rootRunId}`;
    await tx`update allrice_runtime_roots set task=${tx.json(task)} where root_run_id=${rootRunId}`;
    await tx`update allrice_runtime_run_links set task=${tx.json(task)} where run_id=${rootRunId}`;
    await tx`update allrice_runs set input=${tx.json({ assistantConfiguration: base.config })} where id=${rootRunId}`;
  });
  // Assistants are off until saved on; unless told otherwise, this member did.
  const memberAssistants =
    options.memberAssistants === undefined ? true : options.memberAssistants;
  if (memberAssistants !== null)
    await updateWorkAutomation(
      base.context,
      workspace,
      {
        expectedRevision: 0,
        capability: 'assistants',
        enabled: memberAssistants,
      },
      db,
    );
  const runtime = createAssistantRuntime({
    database: db,
    authorize: assertAssistantAuthority,
  });
  const configure = () =>
    runtime.configureRoot({
      task,
      configuration: base.config,
      nativeSessionId: base.nativeSessionId,
      worker: base.worker,
      allowedTools: selectedTools,
    });
  if (options.configure !== false) await configure();
  const authorize = (
    phase: AssistantAuthorityInput['phase'] = 'configure',
    tools = selectedTools,
    requestedTask = task,
  ) =>
    db.begin((transaction) =>
      assertAssistantAuthority({
        transaction,
        task: requestedTask,
        tools,
        phase,
      }),
    );
  return {
    ...base,
    ...identity,
    runtime,
    base: { ...base.base, scope: task.scope },
    configure,
    authorize,
  };
}
