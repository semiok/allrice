import {
  defaultUserPreferences,
  UserPreferencesInputSchema,
  type RequestContext,
  type UserPreferences,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';

function userId(context: RequestContext) {
  if (context.actor.type !== 'user')
    throw new DataAccessError('authentication_required');
  return context.actor.id;
}

export async function getUserPreferences(
  context: RequestContext,
): Promise<UserPreferences> {
  const [row] = await getDatabase()<
    { streaming_output: boolean; updated_at: Date }[]
  >`
    select streaming_output, updated_at from allrice_user_preferences where user_id=${userId(context)}
  `;
  return row
    ? {
        streamingOutput: row.streaming_output,
        updatedAt: row.updated_at.toISOString(),
      }
    : { ...defaultUserPreferences };
}

export async function updateUserPreferences(
  context: RequestContext,
  value: unknown,
): Promise<UserPreferences> {
  const id = userId(context);
  const input = UserPreferencesInputSchema.parse(value);
  const [row] = await getDatabase()<
    { streaming_output: boolean; updated_at: Date }[]
  >`
    insert into allrice_user_preferences (user_id, streaming_output) values (${id}, ${input.streamingOutput})
    on conflict (user_id) do update set streaming_output=excluded.streaming_output, updated_at=clock_timestamp()
    returning streaming_output, updated_at
  `;
  return {
    streamingOutput: row!.streaming_output,
    updatedAt: row!.updated_at.toISOString(),
  };
}
