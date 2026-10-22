import { describe, expect, it } from 'vitest';
import {
  defaultUserPreferences,
  UserPreferencesSchema,
} from './user-preferences.js';

describe('personal display preference compatibility', () => {
  it('reads a prior streaming-only snapshot with the native display defaults', () => {
    expect(
      UserPreferencesSchema.parse({ streamingOutput: false, updatedAt: null }),
    ).toEqual(defaultUserPreferences);
  });
});
