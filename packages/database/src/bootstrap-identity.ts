import { existsSync, readFileSync } from 'node:fs';
import { loadEnvFile } from 'node:process';

import { closeDatabase } from './core/client.ts';
import { ensureBootstrapPortalPrincipal, IdentityError } from './identity.ts';
import {
  checkUsername,
  OrganizationAdministrationError,
} from './organization-administration.ts';
import { isPlatformAdmin } from './platform-authority.ts';

// Like `pnpm dev`, read the repository .env; variables already set win.
const envFile = new URL('../../../.env', import.meta.url);
if (existsSync(envFile)) loadEnvFile(envFile);

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const passwordFile = process.env.ALLRICE_BOOTSTRAP_ADMIN_PASSWORD_FILE;

// Trusted server-side setup of the first account: whoever can run this already
// holds the database credentials. Everything is checked before the single
// transaction; an account that already exists for this email is left as it is.
// Platform authority still comes only from ALLRICE_PLATFORM_ADMIN_EMAILS.
try {
  const username = required('ALLRICE_BOOTSTRAP_ADMIN_USERNAME');
  checkUsername(username);
  const principal = await ensureBootstrapPortalPrincipal({
    organizationSlug: required('ALLRICE_BOOTSTRAP_ORG_SLUG'),
    organizationName: required('ALLRICE_BOOTSTRAP_ORG_NAME'),
    workspaceSlug: process.env.ALLRICE_BOOTSTRAP_WORKSPACE_SLUG || 'default',
    workspaceName: process.env.ALLRICE_BOOTSTRAP_WORKSPACE_NAME || 'Default',
    email: required('ALLRICE_BOOTSTRAP_ADMIN_EMAIL'),
    displayName: process.env.ALLRICE_BOOTSTRAP_ADMIN_NAME || 'Administrator',
    role: 'member',
    login: {
      username,
      password: passwordFile
        ? readFileSync(passwordFile, 'utf8').replace(/\r?\n$/, '')
        : required('ALLRICE_BOOTSTRAP_ADMIN_PASSWORD'),
    },
  });
  console.info(
    JSON.stringify(
      {
        organizationId: principal.organizationId,
        workspaceId: principal.workspaceId,
        userId: principal.user.id,
        accountCreated: principal.created,
        platformAdmin: await isPlatformAdmin({
          actor: { type: 'user', id: principal.user.id },
        }),
      },
      null,
      2,
    ),
  );
} catch (error) {
  process.exitCode = 1;
  const code =
    error && typeof error === 'object' && 'code' in error ? error.code : null;
  console.error(
    error instanceof IdentityError
      ? 'The organization is archived, or this email belongs to a disabled account or one that is not a member of it.'
      : error instanceof OrganizationAdministrationError
        ? 'That username is reserved for the platform administrator login.'
        : code === '23505'
          ? 'That username is already taken.'
          : error instanceof Error && error.name === 'ZodError'
            ? 'Invalid email, username or password (passwords need at least 8 characters).'
            : error instanceof Error
              ? error.message
              : 'Bootstrap failed.',
  );
} finally {
  await closeDatabase();
}
