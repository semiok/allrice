import { z } from 'zod';

export const UserPreferencesInputSchema = z
  .object({
    streamingOutput: z.boolean(),
  })
  .strict();

export const UserPreferencesSchema = UserPreferencesInputSchema.extend({
  updatedAt: z.string().datetime().nullable(),
});
export type UserPreferences = z.infer<typeof UserPreferencesSchema>;

export const defaultUserPreferences: UserPreferences = {
  streamingOutput: false,
  updatedAt: null,
};
