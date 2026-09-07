/** Retired, already deployed draft only. Never execute this archived SQL.
 * Original: docs/architecture/allrice-2.0/archive/0073_gemini_model_provider.sql.txt
 * Reviewed replacement: migrations/0075_gemini_provider_compat.sql
 */
export const archivedMigrationNames = [
  '0073_gemini_model_provider.sql',
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
