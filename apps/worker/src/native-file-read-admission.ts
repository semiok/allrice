import { assertEmployeeChatHumanSource, DataAccessError } from '@allrice/database';

/** Select a transport for an already-authorized ordinary root, never a file
 * grant. Internal/scheduled and unidentified producers retain their transport. */
export async function admitsRootNativeFileRead(
  input: Parameters<typeof assertEmployeeChatHumanSource>[0],
) {
  try {
    await assertEmployeeChatHumanSource(input);
    return true;
  } catch (error) {
    if (error instanceof DataAccessError && error.code === 'authorization_denied')
      return false;
    throw error;
  }
}
