/** Provision shared settings in an already isolated acceptance database.
 * Restore platform authority before running the task as a regular tenant user. */
export async function withFixturePlatformAdministrator<T>(
  syntheticUserId: string,
  action: () => Promise<T>,
): Promise<T> {
  if (!/^[a-f0-9-]{36}$/.test(syntheticUserId))
    throw Error('INVALID_SYNTHETIC_PLATFORM_USER');
  const previous = process.env.ALLRICE_PLATFORM_ADMIN_EMAILS;
  process.env.ALLRICE_PLATFORM_ADMIN_EMAILS = [
    previous,
    `${syntheticUserId}@example.test`,
  ]
    .filter(Boolean)
    .join(',');
  try {
    return await action();
  } finally {
    if (previous === undefined)
      delete process.env.ALLRICE_PLATFORM_ADMIN_EMAILS;
    else process.env.ALLRICE_PLATFORM_ADMIN_EMAILS = previous;
  }
}
