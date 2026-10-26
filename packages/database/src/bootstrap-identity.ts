import { closeDatabase } from './core/client.ts';
import {
  ensureBootstrapPortalPrincipal,
  initializeAccountLogin,
} from './identity.ts';

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

// Trusted server-side setup of the first account: whoever can run this already
// holds the database credentials. Platform authority still comes only from
// ALLRICE_PLATFORM_ADMIN_EMAILS. Re-running never resets an existing login.
try {
  const principal = await ensureBootstrapPortalPrincipal({
    organizationSlug: required('ALLRICE_BOOTSTRAP_ORG_SLUG'),
    organizationName: required('ALLRICE_BOOTSTRAP_ORG_NAME'),
    workspaceSlug: process.env.ALLRICE_BOOTSTRAP_WORKSPACE_SLUG || 'default',
    workspaceName: process.env.ALLRICE_BOOTSTRAP_WORKSPACE_NAME || 'Default',
    email: required('ALLRICE_BOOTSTRAP_ADMIN_EMAIL'),
    displayName: process.env.ALLRICE_BOOTSTRAP_ADMIN_NAME || 'Administrator',
    role: 'member',
  });
  const account = await initializeAccountLogin({
    userId: principal.user.id,
    username: required('ALLRICE_BOOTSTRAP_ADMIN_USERNAME'),
    password: required('ALLRICE_BOOTSTRAP_ADMIN_PASSWORD'),
  });
  console.info(
    JSON.stringify(
      {
        organizationId: principal.organizationId,
        workspaceId: principal.workspaceId,
        userId: principal.user.id,
        username: account.username,
        initialized: account.initialized,
      },
      null,
      2,
    ),
  );
} finally {
  await closeDatabase();
}
