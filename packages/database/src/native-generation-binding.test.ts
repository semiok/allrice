import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = (name: string) =>
  readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
const sql = migration('0218_native_generation_binding.sql');
describe('0218 migration boundaries', () => {
  it.each([
    [
      '0210_current_employee_execution_binding.sql',
      'allrice_employee_execution_binding_guard',
    ],
    ['0195_native_schedule_once.sql', 'allrice_native_once_partition_guard'],
  ])(
    'restores the original guard from %s without changing provenance semantics',
    (file, name) => {
      const body = new RegExp(`function ${name}\\(\\)[\\s\\S]*?\\$\\$;`);
      expect(sql.match(body)?.[0]).toBe(migration(file!).match(body)?.[0]);
    },
  );
  it('limits lock acquisition and never cascades or rewrites business rows', () => {
    expect(sql).toContain("set local lock_timeout = '15s'");
    expect(sql).not.toMatch(/\bcascade\b/i);
    expect(sql).not.toMatch(
      /(?:update|delete from)\s+allrice_(?:chat_sessions|native_session_bindings|employee_runs|native_once_partitions)\b/i,
    );
  });
});
