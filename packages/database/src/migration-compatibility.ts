export const archivedMigrationNames = [
  // MET-221 PR2b-3: retired by 0218; removed in eae68243 (original SQL at 4d5c2e58).
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
