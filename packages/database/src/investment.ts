import { randomUUID, createHash } from 'node:crypto';
import type { TransactionSql, JSONValue } from 'postgres';
import {
  InvestmentContentSchema,
  InvestmentMutationSchema,
  InvestmentRevisionSchema,
  UuidSchema,
  OrganizationDashboardFilterSchema,
  estimateInvestment,
  type InvestmentRevision,
  type InvestmentWork,
  type InvestmentExpense,
  type InvestmentDirectory,
  type RequestContext,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';
import { requireCompanyAssetReader } from './company-assets.ts';
import { requireTenantAdministrationTarget } from './tenant-administration.ts';
import { readArtifact } from './artifact-review.ts';
import {
  businessDeliverablePredicate,
  organizationDashboardPeriod,
  organizationWorkSource,
} from './organization-dashboard.ts';
type Db = ReturnType<typeof getDatabase>;
type Sql = Db | TransactionSql;
export class InvestmentEvidenceError extends Error {
  constructor(
    readonly code:
      | 'version_conflict'
      | 'source_unavailable'
      | 'baseline_unavailable'
      | 'allocation_exceeded'
      | 'expense_revision_changed'
      | 'business_work_exists'
      | 'scope_mismatch',
  ) {
    super(code);
  }
}
type Row = {
  id: string;
  entry_id: string;
  number: number;
  organization_id: string | null;
  workspace_id: string | null;
  owner_id: string;
  content: unknown;
  facts: Record<string, unknown>;
  digest: string;
  created_at: Date;
  created_by: string;
};
function revision(r: Row): InvestmentRevision {
  return InvestmentRevisionSchema.parse({
    id: r.id,
    entryId: r.entry_id,
    number: r.number,
    organizationId: r.organization_id,
    workspaceId: r.workspace_id,
    ownerId: r.owner_id,
    content: r.content,
    facts: r.facts,
    digest: r.digest,
    createdAt: r.created_at.toISOString(),
    createdBy: r.created_by,
  });
}
async function rows(sql: Sql, id: string) {
  return sql<
    Row[]
  >`select r.*,e.organization_id,e.workspace_id,e.owner_id from allrice_investment_revisions r join allrice_investment_entries e on e.id=r.entry_id where r.id=${id}`;
}
function scopedKey(content: ReturnType<typeof InvestmentContentSchema.parse>) {
  return content.kind === 'expense'
    ? content.receiptKey
    : content.kind === 'statement'
      ? new Date(content.from).toISOString() +
        '|' +
        new Date(content.to).toISOString() +
        '|' +
        content.currency
      : content.key;
}
async function committedAllocation(
  sql: Sql,
  expenseId: string,
  except: string | null,
) {
  const [sum] = await sql<
    { amount: string }[]
  >`select coalesce(sum((x->>'amountMinor')::numeric),0)::text amount from allrice_investment_entries e join allrice_investment_revisions r on r.id=e.latest_revision_id cross join lateral jsonb_array_elements(coalesce(r.facts->'subscriptionReferences','[]'::jsonb)) x where e.kind='statement' and (${except}::uuid is null or e.id<>${except}) and x->>'entryId'=${expenseId}`;
  return Number(sum!.amount);
}
export async function saveInvestmentEntry(
  context: RequestContext,
  organizationInput: string,
  input: unknown,
  administration = false,
  db: Db = getDatabase(),
): Promise<InvestmentRevision> {
  const org = UuidSchema.parse(organizationInput),
    mutation = InvestmentMutationSchema.parse(input),
    content = mutation.content;
  try {
    return await db.begin(async (tx) => {
      await requireCompanyAssetReader(context, org, tx, administration);
      if (context.actor.type !== 'user')
        throw new DataAccessError('authorization_denied');
      if ((content.kind === 'work') === administration)
        throw new DataAccessError('authorization_denied');
      const [company] =
        await tx`select id from allrice_organizations where id=${org} and archived_at is null for share`;
      if (!company) throw new DataAccessError('authorization_denied');
      const [actor] =
        await tx`select id from allrice_users where id=${context.actor.id} and status='active' for share`;
      if (!actor) throw new DataAccessError('authorization_denied');
      if (!administration) {
        const memberships =
          await tx`select user_id from allrice_memberships where user_id=${context.actor.id} and organization_id=${org} and active and (workspace_id is null or workspace_id=${context.workspaceId}) for share`;
        if (!memberships.length)
          throw new DataAccessError('authorization_denied');
      }
      const key = scopedKey(content),
        entityOrg = content.kind === 'expense' ? null : org,
        workspace = content.kind === 'work' ? context.workspaceId : null;
      if (content.kind === 'work' && !workspace)
        throw new DataAccessError('authorization_denied');
      const [existing] = await tx<
        {
          id: string;
          kind: string;
          organization_id: string | null;
          workspace_id: string | null;
          owner_id: string;
          revision: number;
          latest_revision_id: string;
          entry_key: string;
        }[]
      >`select * from allrice_investment_entries where id=${mutation.entryId} for update`;
      if (
        existing &&
        (existing.kind !== content.kind ||
          existing.organization_id !== entityOrg ||
          (content.kind === 'work' &&
            (existing.owner_id !== context.actor.id ||
              existing.workspace_id !== workspace)))
      )
        throw new DataAccessError('not_found');
      if ((existing?.revision ?? 0) !== mutation.expectedRevision)
        throw new InvestmentEvidenceError('version_conflict');
      const facts: Record<string, unknown> = {};
      if (content.kind === 'work') {
        const sourceRuns =
          await tx`select r.id,er.session_id from allrice_runs r join allrice_employee_runs er on er.run_id=r.id and er.organization_id=r.organization_id and er.workspace_id=r.workspace_id and er.owner_id=r.owner_id where r.id in ${tx(content.sourceRunIds)} and r.organization_id=${org} and r.workspace_id=${workspace} and r.owner_id=${context.actor.id} and not exists(select 1 from allrice_assistant_instances ai where ai.run_id=r.id and ai.run_id<>ai.root_run_id)`;
        if (sourceRuns.length !== content.sourceRunIds.length)
          throw new InvestmentEvidenceError('source_unavailable');
        facts.sourceRunIds = content.sourceRunIds;
        if (content.baselineRevisionId) {
          const [b] = await rows(tx, content.baselineRevisionId);
          if (
            !b ||
            b.organization_id !== org ||
            InvestmentContentSchema.parse(b.content).kind !== 'baseline'
          )
            throw new InvestmentEvidenceError('baseline_unavailable');
          facts.baselineRevisionId = b.id;
          facts.baselineDigest = b.digest;
        }
        if (content.sourceVersionId) {
          const [v] = await tx<
            { session_id: string; run_id: string }[]
          >`select dv.session_id,a.run_id from allrice_deliverable_versions dv join allrice_workbench_artifacts a on a.version_id=dv.id and a.organization_id=dv.organization_id and a.workspace_id=dv.workspace_id and a.owner_id=dv.owner_id where dv.id=${content.sourceVersionId} and dv.organization_id=${org} and dv.workspace_id=${workspace} and dv.owner_id=${context.actor.id} and dv.platform_test_run_id is null and a.run_id in ${tx(content.sourceRunIds)} and ${businessDeliverablePredicate(tx)}`;
          if (!v) throw new InvestmentEvidenceError('source_unavailable');
          const artifact = await readArtifact(
            tx,
            { ...context, workspaceId: workspace! },
            v.session_id,
            content.sourceVersionId,
          );
          facts.sourceVersion = {
            id: artifact.version.id,
            checksum: artifact.object.checksum,
            fileName: artifact.version.fileName,
            runId: v.run_id,
            sessionId: v.session_id,
          };
        }
        const old = existing
          ? (await rows(tx, existing.latest_revision_id))[0]
          : null;
        facts.reportingAt =
          content.adoptedAt ??
          old?.facts.reportingAt ??
          new Date().toISOString();
      }
      if (content.kind === 'expense') {
        for (const a of content.allocations)
          await requireTenantAdministrationTarget(tx, a.organizationId, null);
        const committed = await committedAllocation(tx, mutation.entryId, null);
        if (committed > content.amountMinor)
          throw new InvestmentEvidenceError('allocation_exceeded');
        if (existing) {
          const old = InvestmentContentSchema.parse(
            (await rows(tx, existing.latest_revision_id))[0]!.content,
          ) as InvestmentExpense;
          if (
            old.currency !== content.currency ||
            Date.parse(old.from) !== Date.parse(content.from) ||
            Date.parse(old.to) !== Date.parse(content.to) ||
            old.receiptKey !== content.receiptKey
          )
            throw new InvestmentEvidenceError('scope_mismatch');
        }
      }
      if (content.kind === 'statement') {
        if (existing && existing.entry_key !== key)
          throw new InvestmentEvidenceError('scope_mismatch');
        const refs: {
          entryId: string;
          revisionId: string;
          digest: string;
          amountMinor: number;
        }[] = [];
        const sourceExpenses = await Promise.all(
          content.subscriptionRevisionIds.map((id) =>
            rows(tx, id).then((rs) => rs[0]),
          ),
        );
        if (
          sourceExpenses.some(
            (r) =>
              !r || InvestmentContentSchema.parse(r.content).kind !== 'expense',
          )
        )
          throw new InvestmentEvidenceError('source_unavailable');
        const expenseIds = sourceExpenses.map((r) => r!.entry_id).sort();
        if (new Set(expenseIds).size !== expenseIds.length)
          throw new InvestmentEvidenceError('allocation_exceeded');
        // Sorted shared-envelope locks serialize concurrent company allocations.
        if (expenseIds.length)
          await tx`select id from allrice_investment_entries where id in ${tx(expenseIds)} order by id for update`;
        for (const r of sourceExpenses) {
          const source = r!,
            expense = InvestmentContentSchema.parse(
              source.content,
            ) as InvestmentExpense;
          const [head] =
            await tx`select latest_revision_id from allrice_investment_entries where id=${source.entry_id}`;
          if (head!.latest_revision_id !== source.id)
            throw new InvestmentEvidenceError('expense_revision_changed');
          if (
            expense.currency !== content.currency ||
            Date.parse(expense.from) !== Date.parse(content.from) ||
            Date.parse(expense.to) !== Date.parse(content.to)
          )
            throw new InvestmentEvidenceError('scope_mismatch');
          const amount = expense.allocations.find(
            (a) => a.organizationId === org,
          )?.amountMinor;
          if (amount === undefined)
            throw new InvestmentEvidenceError('scope_mismatch');
          if (
            (await committedAllocation(tx, source.entry_id, mutation.entryId)) +
              amount >
            expense.amountMinor
          )
            throw new InvestmentEvidenceError('allocation_exceeded');
          refs.push({
            entryId: source.entry_id,
            revisionId: source.id,
            digest: source.digest,
            amountMinor: amount,
          });
        }
        facts.subscriptionReferences = refs;
      }
      if (!existing)
        await tx`insert into allrice_investment_entries(id,kind,organization_id,workspace_id,owner_id,entry_key) values(${mutation.entryId},${content.kind},${entityOrg},${workspace},${context.actor.id},${key})`;
      const id = randomUUID(),
        number = mutation.expectedRevision + 1,
        digest =
          'sha256:' +
          createHash('sha256')
            .update(JSON.stringify({ content, facts }))
            .digest('hex');
      await tx`insert into allrice_investment_revisions(id,entry_id,number,content,facts,digest,created_by) values(${id},${mutation.entryId},${number},${tx.json(content)},${tx.json(facts as JSONValue)},${digest},${context.actor.id})`;
      await tx`update allrice_investment_entries set revision=${number},latest_revision_id=${id},entry_key=${key},source_version_id=${content.kind === 'work' ? content.sourceVersionId : null} where id=${mutation.entryId}`;
      return revision((await rows(tx, id))[0]!);
    });
  } catch (error) {
    if ((error as { code?: string }).code === '23505')
      throw new InvestmentEvidenceError('business_work_exists');
    throw error;
  }
}
export async function listInvestmentEntries(
  context: RequestContext,
  organizationInput: string,
  options: {
    administration?: boolean;
    kind?: 'baseline' | 'work' | 'expense' | 'statement';
    entryId?: string;
    history?: boolean;
    after?: string;
    sourceVersionId?: string;
  } = {},
  db: Db = getDatabase(),
): Promise<InvestmentDirectory> {
  const org = UuidSchema.parse(organizationInput);
  for (const id of [options.entryId, options.after, options.sourceVersionId])
    if (id) UuidSchema.parse(id);
  return db.begin('isolation level repeatable read read only', async (tx) => {
    await requireCompanyAssetReader(context, org, tx, options.administration);
    if (context.actor.type !== 'user')
      throw new DataAccessError('authorization_denied');
    if (
      !options.administration &&
      options.kind &&
      ['expense', 'statement'].includes(options.kind)
    )
      throw new DataAccessError('authorization_denied');
    const rs = await tx<
      Row[]
    >`select r.*,e.organization_id,e.workspace_id,e.owner_id from allrice_investment_entries e join allrice_investment_revisions r on r.entry_id=e.id and (${!!options.history} or r.id=e.latest_revision_id)
   where (e.organization_id=${org} or (${!!options.administration} and e.kind='expense' and e.organization_id is null))
    and (${!!options.administration} or e.kind='baseline' or (e.kind='work' and e.owner_id=${context.actor.id} and e.workspace_id=${context.workspaceId}))
    and (${options.kind ?? null}::text is null or e.kind=${options.kind ?? null}) and (${options.entryId ?? null}::uuid is null or e.id=${options.entryId ?? null}) and (${options.sourceVersionId ?? null}::uuid is null or e.source_version_id=${options.sourceVersionId ?? null})
    and (${options.after ?? null}::uuid is null or r.id>${options.after ?? null}) order by r.id limit 51`;
    return {
      entries: rs.slice(0, 50).map(revision),
      nextCursor: rs.length > 50 ? rs[49]!.id : null,
    };
  });
}
export async function readInvestmentReport(
  context: RequestContext,
  organizationInput: string,
  filterInput: unknown,
  db: Db = getDatabase(),
) {
  const org = UuidSchema.parse(organizationInput),
    filter = OrganizationDashboardFilterSchema.parse(filterInput),
    period = organizationDashboardPeriod(filter, new Date());
  return db.begin('isolation level repeatable read read only', async (tx) => {
    await requireCompanyAssetReader(context, org, tx, true);
    const source = organizationWorkSource(db, org, filter);
    const conditions = tx`e.kind='work' and e.organization_id=${org} and (iv.facts->>'reportingAt')::timestamptz>=${period.from}::timestamptz and (iv.facts->>'reportingAt')::timestamptz<${period.to}::timestamptz and exists(select 1 ${source} and er.run_id::text in (select jsonb_array_elements_text(iv.content->'sourceRunIds')))`;
    const [count] = await tx<
      { n: number }[]
    >`select count(*)::int n from allrice_investment_entries e join allrice_investment_revisions iv on iv.id=e.latest_revision_id where ${conditions}`;
    const samples = await tx<
      Row[]
    >`select iv.*,e.organization_id,e.workspace_id,e.owner_id from allrice_investment_entries e join allrice_investment_revisions iv on iv.id=e.latest_revision_id where ${conditions} order by e.id limit 1000`;
    const works = samples.map(
      (r) => InvestmentContentSchema.parse(r.content) as InvestmentWork,
    );
    const baselineIds = [
      ...new Set(
        works.flatMap((w) =>
          w.baselineRevisionId ? [w.baselineRevisionId] : [],
        ),
      ),
    ];
    const baselineRows = baselineIds.length
      ? await tx<
          Row[]
        >`select br.*,be.organization_id,be.workspace_id,be.owner_id from allrice_investment_revisions br join allrice_investment_entries be on be.id=br.entry_id where br.id in ${tx(baselineIds)} and be.organization_id=${org} and be.kind='baseline'`
      : [];
    const baselines = new Map(baselineRows.map((r) => [r.id, revision(r)]));
    const versionIds = [
      ...new Set(
        works.flatMap((w) => (w.sourceVersionId ? [w.sourceVersionId] : [])),
      ),
    ];
    const available = versionIds.length
      ? await tx<
          {
            id: string;
            owner_id: string;
            workspace_id: string;
            checksum: string;
          }[]
        >`select dv.id,dv.owner_id,dv.workspace_id,so.checksum from allrice_deliverable_versions dv join allrice_storage_objects so on so.id=dv.object_id and so.organization_id=dv.organization_id and so.workspace_id=dv.workspace_id join allrice_workspaces w on w.id=dv.workspace_id and w.organization_id=dv.organization_id where dv.id in ${tx(versionIds)} and dv.organization_id=${org} and dv.platform_test_run_id is null and w.archived_at is null and so.state='ready' and so.deleted_at is null and (so.retention_until is null or so.retention_until>clock_timestamp())`
      : [];
    const versions = new Map(available.map((v) => [v.id, v]));
    const prepared = samples.map((r, index) => {
      const work = works[index]!,
        v = work.sourceVersionId
          ? versions.get(work.sourceVersionId)
          : undefined;
      return {
        revision: revision(r),
        baseline: work.baselineRevisionId
          ? (baselines.get(work.baselineRevisionId) ?? null)
          : null,
        sourceAvailable:
          !!v &&
          v.owner_id === r.owner_id &&
          v.workspace_id === r.workspace_id &&
          v.checksum ===
            (r.facts.sourceVersion as { checksum?: string } | undefined)
              ?.checksum,
      };
    });
    const statements = await tx<
      Row[]
    >`select r.*,e.organization_id,e.workspace_id,e.owner_id from allrice_investment_entries e join allrice_investment_revisions r on r.id=e.latest_revision_id where e.kind='statement' and e.organization_id=${org} order by e.id`;
    return estimateInvestment({
      organizationId: org,
      period,
      samples: prepared,
      candidateWorks: count!.n,
      statements: statements.map(revision),
      filtered: !!(filter.userId || filter.employeeId || filter.jobTitle),
      generatedAt: new Date().toISOString(),
    });
  });
}
