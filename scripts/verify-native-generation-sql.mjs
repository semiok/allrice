import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// 0218 is the removal itself; tests may describe the retired schema. All other
// active SQL and production TS/MJS must stop referring to its dropped objects.
const migration =
  'packages/database/migrations/0218_native_generation_binding.sql';
const sql = readFileSync(migration, 'utf8');
const names = [
  ...sql.matchAll(/drop (?:table|function) if exists\s+([^;]+);/g),
].flatMap((m) => [...m[1].matchAll(/\b(allrice_\w+)/g)].map((n) => n[1]));
const retired = new RegExp(`\\b(?:${names.join('|')})\\b`);
const files = execFileSync('git', ['ls-files', '-z'], {
  encoding: 'utf8',
}).split('\0');
const violations = [];
for (const file of files) {
  if (file === migration || /(?:\.test\.|\.fixture\.|\/fixtures\/)/.test(file))
    continue;
  if (
    !/\.(?:ts|mjs)$/.test(file) &&
    !/^packages\/database\/migrations\/.*\.sql$/.test(file)
  )
    continue;
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (retired.test(line)) violations.push(`${file}:${i + 1}: ${line.trim()}`);
  });
}
if (violations.length)
  throw Error(`Retired native SQL references:\n${violations.join('\n')}`);
console.log(`Native SQL references: checked ${names.length} retired names`);
