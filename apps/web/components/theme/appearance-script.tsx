import { headers } from 'next/headers';
import { getUserPreferences } from '@allrice/database';
import { getRequestContext } from '../../lib/identity/session';
import {
  appearanceScript,
  type WorkspaceAppearance,
} from '../../lib/theme/theme-script';

/** Workspace pages: paints the employee's saved appearance before any
 * content (after the root layout's default). Signed out, or when the read
 * fails, the page keeps the default and re-reads when it comes back to the
 * foreground: these pages rendered without the database before, and the
 * page's own reads report the failure. */
export async function AppearanceScript() {
  const workspace: WorkspaceAppearance = { choice: null, viewer: null };
  try {
    const context = await getRequestContext(
      new Request('http://localhost/', { headers: await headers() }),
    );
    if (context?.actor.type === 'user') {
      workspace.viewer = context.actor.id;
      workspace.choice = (await getUserPreferences(context)).appearance;
    }
  } catch (error) {
    console.error(
      '[theme] saved appearance unavailable',
      error instanceof Error ? error.name : typeof error,
    );
  }
  return (
    <script dangerouslySetInnerHTML={{ __html: appearanceScript(workspace) }} />
  );
}
