import { randomUUID } from 'node:crypto';
import type { TransactionSql } from 'postgres';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as client from './core/client.ts';
import {
  capabilityChecksum,
  resolveEmployeeCapabilitiesForRun,
} from './capabilities/capability-registry.ts';
import { readEmployeeOrganizationContext } from './employees/organization-context.ts';

// A recording SQL tag proves forwarding and mapping only. It does not prove
// PostgreSQL transaction visibility, isolation, locking, or SQL predicates.
function reader(results: unknown[][]) {
  let index = 0;
  const query = vi.fn<
    (...args: [TemplateStringsArray, ...unknown[]]) => Promise<unknown[]>
  >(async () => {
    const rows = results[index++];
    if (!rows) throw Error('unexpected_sql_query');
    return rows;
  });
  return { query, sql: query as unknown as TransactionSql };
}

function fixture() {
  const identity = {
    organizationId: randomUUID(),
    workspaceId: randomUUID(),
    employeeId: randomUUID(),
    actorId: randomUUID(),
  };
  const date = new Date('2026-10-20T00:00:00.000Z');
  const workflowDefinition = {
    schemaVersion: 1,
    steps: [{ key: 'approve', name: 'Approve', kind: 'approval' }],
  };
  const workflow = (name: string) => ({
    binding_id: randomUUID(),
    bound_by: identity.actorId,
    bound_at: date,
    binding_enabled: true,
    source_active: true,
    revision_id: randomUUID(),
    workflow_id: randomUUID(),
    slug: name.toLowerCase(),
    name,
    description: `${name} workflow`,
    revision: 1,
    status: 'published',
    checksum: capabilityChecksum(workflowDefinition),
    definition: workflowDefinition,
    published_at: date,
  });
  const knowledgeDefinition = {
    schemaVersion: 1,
    sourceKind: 'managed',
    resourceRef: 'transaction-reader-fixture',
    allowedScopes: ['organization', 'employee'],
  };
  const knowledge = (
    name: string,
    principalType: string,
    principalId: string,
  ) => ({
    binding_id: randomUUID(),
    bound_by: identity.actorId,
    bound_at: date,
    binding_enabled: true,
    source_active: true,
    revision_id: randomUUID(),
    knowledge_source_id: randomUUID(),
    slug: name.toLowerCase(),
    name,
    description: `${name} knowledge`,
    revision: 1,
    status: 'published',
    checksum: capabilityChecksum(knowledgeDefinition),
    definition: knowledgeDefinition,
    published_at: date,
    principal_type: principalType,
    principal_id: principalId,
    permission: 'read',
  });
  const allowed = knowledge('Alpha', 'organization', identity.organizationId);
  const employee = knowledge('Zulu', 'employee', identity.employeeId);
  const workflows = [workflow('Alpha'), workflow('Zulu')];
  const knowledgeRows = [
    allowed,
    { ...allowed, principal_type: 'user', principal_id: randomUUID() },
    knowledge('Hidden', 'organization', randomUUID()),
    employee,
  ];
  return { identity, workflows, knowledgeRows, allowed, employee };
}

function forbidPool() {
  return vi.spyOn(client, 'getDatabase').mockImplementation(() => {
    throw Error('unexpected_global_database');
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('employee Run reader transaction forwarding', () => {
  it('reads organization body only through the supplied transaction tag', async () => {
    const pool = forbidPool();
    const organizationId = randomUUID();
    const userId = randomUUID();
    const tx = reader([
      [
        {
          company_name: 'Company',
          business_context: 'Private organization body',
          display_name: 'Person',
          job_title: 'Role',
          responsibilities: 'Duties',
        },
      ],
    ]);
    await expect(
      readEmployeeOrganizationContext(organizationId, userId, tx.sql),
    ).resolves.toEqual({
      organizationId,
      userId,
      companyName: 'Company',
      businessContext: 'Private organization body',
      displayName: 'Person',
      jobTitle: 'Role',
      responsibilities: 'Duties',
    });
    expect(pool).not.toHaveBeenCalled();
    expect(tx.query).toHaveBeenCalledTimes(1);
    expect(tx.query.mock.calls[0]?.slice(1)).toEqual([userId, organizationId]);
  });

  it('keeps the default organization reader and missing-row error', async () => {
    const sql = reader([[]]);
    const pool = vi
      .spyOn(client, 'getDatabase')
      .mockReturnValue(
        sql.sql as unknown as ReturnType<typeof client.getDatabase>,
      );
    await expect(
      readEmployeeOrganizationContext(randomUUID(), randomUUID()),
    ).rejects.toThrow('employee_organization_context_not_found');
    expect(pool).toHaveBeenCalledTimes(1);
    expect(sql.query).toHaveBeenCalledTimes(1);
  });

  it('forwards both capability queries and keeps ACL filtering and row order', async () => {
    const pool = forbidPool();
    const f = fixture();
    const tx = reader([f.workflows, f.knowledgeRows]);
    const result = await resolveEmployeeCapabilitiesForRun(f.identity, tx.sql);
    expect(pool).not.toHaveBeenCalled();
    expect(tx.query).toHaveBeenCalledTimes(2);
    for (const call of tx.query.mock.calls) {
      expect(call.slice(1)).toEqual([
        f.identity.organizationId,
        f.identity.workspaceId,
        f.identity.employeeId,
        false,
      ]);
    }
    expect(result.workflows.map((item) => item.bindingId)).toEqual(
      f.workflows.map((row) => row.binding_id),
    );
    expect(result.knowledge.map((item) => item.bindingId)).toEqual([
      f.allowed.binding_id,
      f.employee.binding_id,
    ]);
    expect(result.knowledge[0]?.revision.acl).toHaveLength(2);
    expect(result.knowledge[0]?.effectiveAcl).toEqual([
      {
        principalType: 'organization',
        principalId: f.identity.organizationId,
        permission: 'read',
      },
    ]);
    expect(result.knowledge.every((item) => item.effective)).toBe(true);
  });

  it('keeps the default capability wrapper output equal to the explicit reader', async () => {
    const f = fixture();
    const tx = reader([f.workflows, f.knowledgeRows]);
    const sql = reader([f.workflows, f.knowledgeRows]);
    const pool = vi
      .spyOn(client, 'getDatabase')
      .mockReturnValue(
        sql.sql as unknown as ReturnType<typeof client.getDatabase>,
      );
    const explicit = await resolveEmployeeCapabilitiesForRun(
      f.identity,
      tx.sql,
    );
    expect(pool).not.toHaveBeenCalled();
    expect(await resolveEmployeeCapabilitiesForRun(f.identity)).toEqual(
      explicit,
    );
    expect(pool).toHaveBeenCalledTimes(1);
    expect(sql.query).toHaveBeenCalledTimes(2);
  });

  it('still validates UUIDs before acquiring a default connection', async () => {
    const pool = forbidPool();
    const f = fixture();
    await expect(
      resolveEmployeeCapabilitiesForRun({ ...f.identity, actorId: 'bad-uuid' }),
    ).rejects.toMatchObject({ name: 'ZodError' });
    expect(pool).not.toHaveBeenCalled();
  });

  it('propagates a supplied-reader failure without falling back to the pool', async () => {
    const pool = forbidPool();
    const f = fixture();
    const failure = Error('transaction_query_failed');
    const query = vi.fn(async () => {
      throw failure;
    });
    await expect(
      resolveEmployeeCapabilitiesForRun(
        f.identity,
        query as unknown as TransactionSql,
      ),
    ).rejects.toBe(failure);
    expect(pool).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(2);
  });
});
