import { headers } from 'next/headers';
import type { Appearance } from '@allrice/contracts';
import { getUserPreferences } from '@allrice/database';
import { getRequestContext } from '../../lib/identity/session';
import { appearanceScript } from '../../lib/theme/theme-script';

/** Signed-in workspace pages: paints the employee's saved appearance before
 * any content (after the root layout's default). Signed-out pages, and a
 * failed read, keep the default: these pages rendered without the database
 * before, and the page's own reads report the failure. */
export async function AppearanceScript() {
  let appearance: Appearance | null = null;
  try {
    const context = await getRequestContext(
      new Request('http://localhost/', { headers: await headers() }),
    );
    if (context?.actor.type === 'user')
      appearance = (await getUserPreferences(context)).appearance;
  } catch (error) {
    console.error(
      '[theme] saved appearance unavailable',
      error instanceof Error ? error.name : typeof error,
    );
  }
  return appearance ? (
    <script
      dangerouslySetInnerHTML={{ __html: appearanceScript(appearance) }}
    />
  ) : null;
}
