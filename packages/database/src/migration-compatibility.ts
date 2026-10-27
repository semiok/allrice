/** Retired, already deployed draft only. Never execute this archived SQL.
 * Original: docs/architecture/allrice-2.0/archive/0073_gemini_model_provider.sql.txt
 * Reviewed replacement: migrations/0075_gemini_provider_compat.sql
 */
export const archivedMigrationNames = [
  '0073_gemini_model_provider.sql',
  // MET-221 PR2b-3: retired by 0218; original SQL at 4d5c2e58.
  '0213_native_chat_executor_transitions.sql',
  '0214_native_control_cloud_absence.sql',
  '0215_terminal_native_test_retirements.sql',
  '0216_native_legacy_chat_adoption.sql',
] as const;

export function migrationsMatch(
  expected: readonly string[],
  applied: readonly string[],
) {
  const archived: ReadonlySet<string> = new Set(archivedMigrationNames);
  const active = applied.filter((name) => !archived.has(name));
  return (
    new Set(applied).size === applied.length &&
    JSON.stringify([...active].sort()) === JSON.stringify([...expected].sort())
  );
}
