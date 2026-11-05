import { expect, it, vi } from 'vitest';
const gate = vi.hoisted(() => vi.fn());
vi.mock('@allrice/database', async (original) => ({
  ...(await original<object>()), assertEmployeeChatHumanSource: gate,
}));
import { DataAccessError } from '@allrice/database';
import { admitsRootNativeFileRead } from './native-file-read-admission.js';
it('uses the existing server source gate; denied scheduled/internal/unknown sources retain their transport', async () => {
  const input = {} as Parameters<typeof admitsRootNativeFileRead>[0];
  gate.mockResolvedValueOnce(undefined);
  expect(await admitsRootNativeFileRead(input)).toBe(true);
  expect(gate).toHaveBeenLastCalledWith(input);
  gate.mockRejectedValueOnce(new DataAccessError('authorization_denied'));
  expect(await admitsRootNativeFileRead(input)).toBe(false);
  const cause = Error('source lookup unavailable');
  gate.mockRejectedValueOnce(cause);
  await expect(admitsRootNativeFileRead(input)).rejects.toBe(cause);
});
