import { randomUUID } from 'node:crypto';

import {
  createSession,
  getDatabase,
  revokeSession,
} from '../../../packages/database/src/index.ts';

const baseUrl =
  process.env.ALLRICE_ACCEPTANCE_BASE_URL ?? 'http://127.0.0.1:3001';
const platformEmail =
  process.env.ALLRICE_ACCEPTANCE_PLATFORM_EMAIL ?? 'semiokshen@gmail.com';

const sql = getDatabase();
const rows = await sql<
  {
    user_id: string;
    organization_id: string;
    workspace_id: string;
    assignment_id: string;
    employee_version_id: string;
  }[]
>`
  select u.id as user_id, m.organization_id, a.workspace_id,
    a.id as assignment_id, a.employee_version_id
  from allrice_users u
  join allrice_memberships m on m.user_id = u.id and m.active
  join allrice_employee_assignments a
    on a.organization_id = m.organization_id
   and a.user_id = u.id
   and a.active
   and a.is_default
  where lower(u.email) = lower(${platformEmail}) and u.status = 'active'
  order by m.created_at
  limit 1
`;
const binding = rows[0];
if (!binding) {
  await sql.end();
  throw new Error(`default Rice assignment for ${platformEmail} was not found`);
}

const identitySession = await createSession(binding.user_id);
const headers = {
  'content-type': 'application/json',
  cookie: `allrice_session=${identitySession.token}`,
  'x-allrice-organization-id': binding.organization_id,
  'x-allrice-workspace-id': binding.workspace_id,
};

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(
      `${response.url} returned ${response.status}: ${await response.text()}`,
    );
  }
  return (await response.json()) as T;
}

async function submitAndWait(sessionId: string, text: string) {
  const submitted = await readJson<{ run: { id: string } }>(
    await fetch(
      new URL(
        `/api/v1/sessions/${sessionId}/messages?workspaceId=${binding!.workspace_id}`,
        baseUrl,
      ),
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          clientMessageId: randomUUID(),
          text,
          attachmentIds: [],
          deliveryMode: 'auto',
        }),
      },
    ),
  );
  const deadline = Date.now() + 120_000;
  let state = 'queued';
  let errorCode: string | null = null;
  while (Date.now() < deadline) {
    const runRows = await sql<{ state: string; error_code: string | null }[]>`
      select state, error_code from allrice_runs where id = ${submitted.run.id}
    `;
    state = runRows[0]?.state ?? 'missing';
    errorCode = runRows[0]?.error_code ?? null;
    if (
      ['succeeded', 'failed', 'canceled', 'needs_attention'].includes(state)
    ) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (state !== 'succeeded') {
    throw new Error(
      `ChatFlow run ${submitted.run.id} ended as ${state} (${errorCode ?? 'no error code'})`,
    );
  }
  const decisions = await sql<
    {
      harness: string;
      provider: string;
      model: string;
      status: string;
      reason_codes: string[];
    }[]
  >`
    select harness, provider, model, status, reason_codes
    from allrice_route_decisions
    where run_id = ${submitted.run.id}
    order by attempt desc
    limit 1
  `;
  const decision = decisions[0];
  if (
    !decision ||
    decision.harness !== 'dsh' ||
    decision.provider !== 'openai-codex' ||
    decision.status !== 'succeeded'
  ) {
    throw new Error(
      `unexpected route decision: ${JSON.stringify(decision ?? null)}`,
    );
  }
  return { runId: submitted.run.id, decision };
}

try {
  const created = await readJson<{ session: { id: string } }>(
    await fetch(new URL('/api/v1/sessions', baseUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        workspaceId: binding.workspace_id,
        employeeAssignmentId: binding.assignment_id,
        employeeVersionId: binding.employee_version_id,
        title: 'MET-81 DSH Codex provider acceptance',
      }),
    }),
  );
  const first = await submitAndWait(
    created.session.id,
    '请记住验收代号 RICE-6281，只回复：已记住。',
  );
  const firstRuntime = await sql<
    { thread_id: string | null; thread_generation: number }[]
  >`
    select thread_id, thread_generation
    from allrice_conversation_runtimes
    where session_id = ${created.session.id}
  `;
  const second = await submitAndWait(
    created.session.id,
    '上一条消息中的验收代号是什么？只回复代号。',
  );
  const secondRuntime = await sql<
    { thread_id: string | null; thread_generation: number }[]
  >`
    select thread_id, thread_generation
    from allrice_conversation_runtimes
    where session_id = ${created.session.id}
  `;
  const firstBinding = firstRuntime[0];
  const secondBinding = secondRuntime[0];
  if (
    !firstBinding?.thread_id ||
    firstBinding.thread_id !== secondBinding?.thread_id ||
    firstBinding.thread_generation !== secondBinding.thread_generation
  ) {
    throw new Error(
      `DSH native Session was not reused: ${JSON.stringify({ firstBinding, secondBinding })}`,
    );
  }
  const answers = await sql<{ text: string }[]>`
    select m.content ->> 'text' as text
    from allrice_employee_runs er
    join allrice_messages m on m.id = er.assistant_message_id
    where er.run_id = ${second.runId} and m.status = 'completed'
  `;
  if (!answers[0]?.text.includes('RICE-6281')) {
    throw new Error('the second turn did not retain the first-turn context');
  }
  const eventRows = await sql<
    { run_id: string; events: number; sequences: number }[]
  >`
    select run_id, count(*)::integer as events,
      count(distinct sequence)::integer as sequences
    from allrice_run_events
    where run_id in (${first.runId}, ${second.runId})
    group by run_id
  `;
  if (
    eventRows.length !== 2 ||
    eventRows.some((row) => row.events !== row.sequences)
  ) {
    throw new Error(
      `duplicate event sequence detected: ${JSON.stringify(eventRows)}`,
    );
  }
  const eventsUrl = new URL(
    `/api/v1/runs/${second.runId}/events?workspaceId=${binding.workspace_id}&format=json`,
    baseUrl,
  );
  const fullStream = await readJson<{
    events: Array<{
      cursor: string;
      sequence: number;
      harness: string | null;
      type: string;
    }>;
  }>(
    await fetch(eventsUrl, {
      headers: { ...headers, accept: 'application/json' },
    }),
  );
  if (
    fullStream.events.length < 2 ||
    fullStream.events.some(
      (event) => event.harness !== null && event.harness !== 'dsh',
    )
  ) {
    throw new Error('ChatFlow 3.0 did not expose a canonical DSH event stream');
  }
  const reconnectCursor =
    fullStream.events[Math.floor(fullStream.events.length / 2)]!.cursor;
  const resumed = await readJson<typeof fullStream>(
    await fetch(eventsUrl, {
      headers: {
        ...headers,
        accept: 'application/json',
        'last-event-id': reconnectCursor,
      },
    }),
  );
  const cursorSequence = fullStream.events.find(
    (event) => event.cursor === reconnectCursor,
  )!.sequence;
  if (
    resumed.events.length === 0 ||
    resumed.events.some((event) => event.sequence <= cursorSequence) ||
    new Set(resumed.events.map((event) => event.sequence)).size !==
      resumed.events.length
  ) {
    throw new Error('ChatFlow cursor reconnect replayed or lost events');
  }
  process.stdout.write(
    `${JSON.stringify({
      status: 'ok',
      sessionId: created.session.id,
      runIds: [first.runId, second.runId],
      harness: second.decision.harness,
      provider: second.decision.provider,
      model: second.decision.model,
      nativeThreadReused: true,
      threadGeneration: secondBinding.thread_generation,
      contextRetained: true,
      eventSequencesUnique: true,
      cursorReconnect: true,
      eventContract: 'chatflow-native-v3',
    })}\n`,
  );
} finally {
  await revokeSession(identitySession.token);
  await sql.end();
}
