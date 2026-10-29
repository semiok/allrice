import type { getDatabase } from '../../../../packages/database/src/core/client.ts';

// These tables remain passive history in the executor-first retirement phase.
// Read the fixture's own schema so public cannot hide a missing relation.
export async function readRetiredExecutionHistory(
  db: ReturnType<typeof getDatabase>,
) {
  const [scope] = await db<
    { schema: string }[]
  >`select current_schema() as schema`;
  return Object.fromEntries(
    await Promise.all(
      [
        'allrice_assistant_roots',
        'allrice_assistant_instances',
        'allrice_assistant_messages',
        'allrice_assistant_results',
        'allrice_assistant_usage',
        'allrice_assistant_artifacts',
        'allrice_assistant_model_admissions',
        'allrice_assistant_price_snapshots',
        'allrice_assistant_cost_receipts',
        'allrice_development_deliveries',
        'allrice_development_reviews',
        'allrice_development_verifiers',
        'allrice_development_merge_sources',
        'allrice_development_merges',
        'allrice_development_proposals',
        'allrice_development_assignments',
        'allrice_development_heads',
      ].map(async (table) => {
        const rows = await db`
          select to_jsonb(history) as value
          from ${db(`${scope!.schema}.${table}`)} history
          order by to_jsonb(history)::text`;
        return [table, rows.map((row) => row.value)];
      }),
    ),
  );
}
