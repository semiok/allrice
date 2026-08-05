import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { closeDatabase, getDatabase } from './index.js';

const sql = getDatabase();
const migrationsDirectory = fileURLToPath(
  new URL('../migrations/', import.meta.url),
);

await sql.begin(async (transaction) => {
  await transaction`select pg_advisory_xact_lock(9223372036854770000)`;
  await transaction.unsafe(`
    create table if not exists allrice_schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const appliedRows = await transaction<{ name: string }[]>`
    select name from allrice_schema_migrations order by name
  `;
  const applied = new Set(appliedRows.map((row) => row.name));
  const files = (await readdir(migrationsDirectory))
    .filter((file) => file.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const migration = await readFile(`${migrationsDirectory}/${file}`, 'utf8');
    await transaction.unsafe(migration);
    await transaction`insert into allrice_schema_migrations (name) values (${file})`;
    console.info(`[M5] applied migration ${file}`);
  }
});

await closeDatabase();
