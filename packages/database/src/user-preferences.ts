import {
  defaultUserPreferences,
  runtimePolicyActionDecision,
  UserPreferencesInputSchema,
  type QuestionWait,
  type RequestContext,
  type UserPreferences,
} from '@allrice/contracts';
import type { Sql, TransactionSql } from 'postgres';
import { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';
import {
  readRuntimePolicyControls,
  RuntimePolicyError,
} from './runtime-policy.ts';

type PreferenceRow = {
  streaming_output: boolean;
  font_size: number;
  transcript_view: UserPreferences['transcriptView'];
  collapse_timing: UserPreferences['collapseTiming'];
  appearance: UserPreferences['appearance'];
  question_wait_mode: QuestionWait['mode'];
  question_wait_seconds: number | null;
  subagent_max_depth: number | null;
  subagent_max_active: number | null;
  updated_at: Date;
};

const columns = (sql: Sql | TransactionSql) => sql`
  streaming_output, font_size, transcript_view, collapse_timing, appearance,
  question_wait_mode, question_wait_seconds,
  subagent_max_depth::float8 as subagent_max_depth,
  subagent_max_active::float8 as subagent_max_active, updated_at`;

function questionWait(row: PreferenceRow): QuestionWait {
  return row.question_wait_mode === 'timed'
    ? { mode: 'timed', seconds: row.question_wait_seconds! }
    : { mode: row.question_wait_mode };
}

function preferenceView(row: PreferenceRow): UserPreferences {
  return {
    streamingOutput: row.streaming_output,
    fontSize: row.font_size,
    transcriptView: row.transcript_view,
    collapseTiming: row.collapse_timing,
    appearance: row.appearance,
    questionWait: questionWait(row),
    subagents: {
      maxDepth: row.subagent_max_depth,
      maxActive: row.subagent_max_active,
    },
    updatedAt: row.updated_at.toISOString(),
  };
}

function userId(context: RequestContext) {
  if (context.actor.type !== 'user')
    throw new DataAccessError('authentication_required');
  return context.actor.id;
}

export async function getUserPreferences(
  context: RequestContext,
): Promise<UserPreferences> {
  const sql = getDatabase();
  const [row] = await sql<PreferenceRow[]>`
    select ${columns(sql)}
    from allrice_user_preferences where user_id=${userId(context)}
  `;
  return row ? preferenceView(row) : { ...defaultUserPreferences };
}

export async function updateUserPreferences(
  context: RequestContext,
  value: unknown,
): Promise<UserPreferences> {
  const id = userId(context);
  const input = UserPreferencesInputSchema.parse(value);
  const wait = input.questionWait ?? defaultUserPreferences.questionWait;
  const subagents = input.subagents ?? defaultUserPreferences.subagents;
  const sql = getDatabase();
  const [row] = await sql<PreferenceRow[]>`
    insert into allrice_user_preferences (user_id, streaming_output, font_size, transcript_view, collapse_timing, appearance,
      question_wait_mode, question_wait_seconds, subagent_max_depth, subagent_max_active)
    values (${id}, ${input.streamingOutput ?? defaultUserPreferences.streamingOutput},
      ${input.fontSize ?? defaultUserPreferences.fontSize},
      ${input.transcriptView ?? defaultUserPreferences.transcriptView},
      ${input.collapseTiming ?? defaultUserPreferences.collapseTiming},
      ${input.appearance ?? defaultUserPreferences.appearance},
      ${wait.mode}, ${wait.mode === 'timed' ? wait.seconds : null},
      ${subagents.maxDepth}, ${subagents.maxActive})
    on conflict (user_id) do update set
      streaming_output=coalesce(${input.streamingOutput ?? null}::boolean, allrice_user_preferences.streaming_output),
      font_size=coalesce(${input.fontSize ?? null}::integer, allrice_user_preferences.font_size),
      transcript_view=coalesce(${input.transcriptView ?? null}::text, allrice_user_preferences.transcript_view),
      collapse_timing=coalesce(${input.collapseTiming ?? null}::text, allrice_user_preferences.collapse_timing),
      appearance=coalesce(${input.appearance ?? null}::text, allrice_user_preferences.appearance),
      question_wait_mode=coalesce(${input.questionWait?.mode ?? null}::text, allrice_user_preferences.question_wait_mode),
      question_wait_seconds=case when ${input.questionWait ? 1 : 0}::integer=1
        then ${input.questionWait?.mode === 'timed' ? input.questionWait.seconds : null}::integer
        else allrice_user_preferences.question_wait_seconds end,
      subagent_max_depth=case when ${input.subagents !== undefined}::boolean
        then excluded.subagent_max_depth else allrice_user_preferences.subagent_max_depth end,
      subagent_max_active=case when ${input.subagents !== undefined}::boolean
        then excluded.subagent_max_active else allrice_user_preferences.subagent_max_active end,
      updated_at=clock_timestamp()
    returning ${columns(sql)}
  `;
  return preferenceView(row!);
}

/**
 * MET-210: the agent preferences one Run is frozen with, read for the session
 * owner when the Run is queued. A denied assistant.delegate decision freezes
 * maxDepth to 0; policy evaluation stays with the shared runtime decision.
 * Only company policy is read; no legacy member assistants switch is consulted.
 * Existing Runs keep their stored decision when the default policy changes.
 */
export async function freezeNativePreferences(
  sql: Sql | TransactionSql,
  scope: { organizationId: string; workspaceId: string; userId: string },
) {
  const [row] = await sql<PreferenceRow[]>`
    select ${columns(sql)}
    from allrice_user_preferences where user_id=${scope.userId}
  `;
  const preferences = row ? preferenceView(row) : defaultUserPreferences;
  const controls = await readRuntimePolicyControls(sql, scope, false).catch(
    (error: unknown) => {
      if (
        error instanceof RuntimePolicyError &&
        error.code === 'runtime_policy_missing_or_invalid'
      )
        return null;
      throw error;
    },
  );
  const delegationClosed =
    runtimePolicyActionDecision(controls, 'assistant.delegate').effect ===
    'deny';
  return {
    version: 1 as const,
    questionWait: preferences.questionWait,
    subagents: {
      ...preferences.subagents,
      ...(delegationClosed ? { maxDepth: 0 } : {}),
    },
  };
}
