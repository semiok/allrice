/** Run after db:migrate. Defaults to a read-only preview; --apply commits once. */
import { readFile } from 'node:fs/promises';
import { migrateLegacyOrganizationAccounts } from '../packages/database/src/organization-migration.ts';
import { closeDatabase } from '../packages/database/src/core/client.ts';
import { legacyPortalMigrationAccounts } from '../apps/web/lib/portal/config.ts';
try {
  const args = process.argv.slice(2);
  if (args.some((a) => a !== '--apply' && !a.startsWith('--manifest=')))
    throw Error(
      'usage: tsx scripts/migrate-organization-accounts.ts [--apply] [--manifest=/private/accounts.json]',
    );
  const manifest = args
    .find((a) => a.startsWith('--manifest='))
    ?.slice('--manifest='.length);
  // A manifest may name additional legacy accounts; never infer a company from a nickname.
  const input = manifest
    ? JSON.parse(await readFile(manifest, 'utf8'))
    : legacyPortalMigrationAccounts();
  const result = await migrateLegacyOrganizationAccounts(
    input,
    args.includes('--apply'),
  );
  console.info(JSON.stringify(result, null, 2));
} catch (error) {
  // SQL diagnostics or validation inputs can contain deployment credentials.
  const message = error instanceof Error ? error.message : '';
  console.error(
    /^migration_[a-z_]+$|^duplicate_migration_account$|^usage:/.test(message)
      ? message
      : 'Account migration failed; no partial changes were committed.',
  );
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
