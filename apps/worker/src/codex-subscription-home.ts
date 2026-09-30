import { resolve } from 'node:path';
import { requireEnabledCodexSubscription } from '@allrice/database';

/** Slot 1 keeps the existing DSH store in place. DSH owns OAuth persistence and
 * refresh for both slots; selecting a slot never copies/replaces credentials. */
export function codexSubscriptionHome(slot: 1 | 2) {
  const root = resolve(
    process.env.ALLRICE_DSH_PLATFORM_HOME ?? '.local/dsh-platform',
  );
  return slot === 1 ? root : resolve(root, 'codex-subscriptions', '2');
}

export async function activeCodexSubscriptionHome() {
  return codexSubscriptionHome(await requireEnabledCodexSubscription());
}
