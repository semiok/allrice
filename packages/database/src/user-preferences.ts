import {
  defaultUserPreferences,
  UserPreferencesInputSchema,
  type RequestContext,
  type UserPreferences,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';

type PreferenceRow = {
  streaming_output: boolean;
  font_size: number;
  transcript_view: UserPreferences['transcriptView'];
  collapse_timing: UserPreferences['collapseTiming'];
  appearance: UserPreferences['appearance'];
  updated_at: Date;
};

function preferenceView(row: PreferenceRow): UserPreferences {
  return {
    streamingOutput: row.streaming_output,
    fontSize: row.font_size,
    transcriptView: row.transcript_view,
    collapseTiming: row.collapse_timing,
    appearance: row.appearance,
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
  const [row] = await getDatabase()<PreferenceRow[]>`
    select streaming_output, font_size, transcript_view, collapse_timing, appearance, updated_at
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
  const [row] = await getDatabase()<PreferenceRow[]>`
    insert into allrice_user_preferences (user_id, streaming_output, font_size, transcript_view, collapse_timing, appearance)
    values (${id}, ${input.streamingOutput ?? defaultUserPreferences.streamingOutput},
      ${input.fontSize ?? defaultUserPreferences.fontSize},
      ${input.transcriptView ?? defaultUserPreferences.transcriptView},
      ${input.collapseTiming ?? defaultUserPreferences.collapseTiming},
      ${input.appearance ?? defaultUserPreferences.appearance})
    on conflict (user_id) do update set
      streaming_output=coalesce(${input.streamingOutput ?? null}::boolean, allrice_user_preferences.streaming_output),
      font_size=coalesce(${input.fontSize ?? null}::integer, allrice_user_preferences.font_size),
      transcript_view=coalesce(${input.transcriptView ?? null}::text, allrice_user_preferences.transcript_view),
      collapse_timing=coalesce(${input.collapseTiming ?? null}::text, allrice_user_preferences.collapse_timing),
      appearance=coalesce(${input.appearance ?? null}::text, allrice_user_preferences.appearance),
      updated_at=clock_timestamp()
    returning streaming_output, font_size, transcript_view, collapse_timing, appearance, updated_at
  `;
  return preferenceView(row!);
}
