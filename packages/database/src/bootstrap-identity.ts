import { bootstrapOrganization, closeDatabase } from './index.ts';

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

try {
  const result = await bootstrapOrganization({
    organizationSlug: required('ALLRICE_BOOTSTRAP_ORG_SLUG'),
    organizationName: required('ALLRICE_BOOTSTRAP_ORG_NAME'),
    workspaceSlug: process.env.ALLRICE_BOOTSTRAP_WORKSPACE_SLUG || 'default',
    workspaceName: process.env.ALLRICE_BOOTSTRAP_WORKSPACE_NAME || 'Default',
    adminEmail: required('ALLRICE_BOOTSTRAP_ADMIN_EMAIL'),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  });
  console.info(JSON.stringify(result, null, 2));
} finally {
  await closeDatabase();
}
