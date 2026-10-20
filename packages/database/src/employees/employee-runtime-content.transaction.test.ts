import { randomUUID } from 'node:crypto';
import type { TransactionSql } from 'postgres';
import {
  EmployeeContentManifestSchema,
  EmployeeInstanceSnapshotSchema,
} from '@allrice/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as client from '../core/client.ts';
import { runtimePolicyDigest } from '../runtime-policy.ts';
import { prepareEmployeeRuntimeContent } from './employee-runtime-content.ts';

function fixture() {
  const context = {
    actor: { type: 'user' as const, id: randomUUID() },
    organizationId: randomUUID(),
    workspaceId: randomUUID(),
  };
  const employeeId = randomUUID();
  const versionId = randomUUID();
  const version = { kind: 'tenant_version', employeeVersionId: versionId };
  const instance = EmployeeInstanceSnapshotSchema.parse({
    id: randomUUID(),
    assignmentId: randomUUID(),
    organizationId: context.organizationId,
    workspaceId: context.workspaceId,
    ownerId: context.actor.id,
    kind: 'custom',
    revision: 1,
    profile: {},
    creationSource: version,
    source: version,
  });
  const date = new Date('2026-10-20T00:00:00.000Z');
  const body = { title: 'Requirement', body: 'TRANSACTION_CONTENT_SENTINEL' };
  const reference = {
    sourceKind: 'requirement' as const,
    contentId: randomUUID(),
    revisionId: randomUUID(),
    digest: runtimePolicyDigest(body),
  };
  const manifest = EmployeeContentManifestSchema.parse({
    schemaVersion: 1,
    common: [reference],
    scenes: [],
    declaredConflicts: [],
  });
  const set = {
    id: randomUUID(),
    organization_id: context.organizationId,
    workspace_id: context.workspaceId,
    employee_id: employeeId,
    instance_id: null,
    scope: 'company',
    owner_id: null,
    department_id: null,
    revision: 1,
    candidate_revision_id: null,
    active_revision_id: randomUUID(),
    validation: null,
  };
  const revision = {
    id: set.active_revision_id,
    set_id: set.id,
    number: 1,
    manifest,
    digest: runtimePolicyDigest(manifest),
    change_summary: 'Unit fixture',
    restored_from_revision_id: null,
    created_at: date,
  };
  return {
    context,
    input: { instance, employeeId, employeeVersionId: versionId },
    reference,
    set,
    revision,
    instanceRow: {
      id: instance.id,
      organization_id: context.organizationId,
      workspace_id: context.workspaceId,
      owner_id: context.actor.id,
      assignment_id: instance.assignmentId,
      kind: instance.kind,
      creation_version_id: versionId,
      current_version_id: versionId,
      revision: 1,
      profile: {},
      created_at: date,
      updated_at: date,
      archived_at: null,
    },
    assignmentRow: {
      id: instance.assignmentId,
      employee_id: employeeId,
      employee_version_id: versionId,
    },
    assetRow: {
      kind: 'execution_requirement',
      content_scope: 'company',
      organization_id: context.organizationId,
      owner_id: context.actor.id,
      department_id: null,
      content_workspace_id: context.workspaceId,
      revision: 1,
      latest_revision_id: reference.revisionId,
      published_revision_id: reference.revisionId,
      state: 'published',
      digest: reference.digest,
      content: body,
      published: true,
    },
  };
}

// Static row fixtures for the existing freeze/read functions. This records SQL
// routing; it does not evaluate SQL scope predicates or prove PostgreSQL ACLs,
// transaction isolation, locks, publication visibility, or rollback.
function reader(
  f: ReturnType<typeof fixture>,
  options: {
    missingReadLayer?: boolean;
    failure?: { includes: string; error: Error };
  } = {},
) {
  const statements: string[] = [];
  const query = vi.fn<
    (
      ...args: [TemplateStringsArray | readonly string[], ...unknown[]]
    ) => unknown
  >((parts) => {
    if (!('raw' in parts)) return { identifiers: parts };
    const text = parts.join('?').replace(/\s+/g, ' ').trim();
    if (!text) return { fragment: '' };
    statements.push(text);
    if (options.failure && text.includes(options.failure.includes)) {
      throw options.failure.error;
    }
    if (text.includes('from allrice_users u join allrice_organizations o')) {
      return Promise.resolve([
        {
          department_id: null,
          maintenance_level: 'company',
          writable: true,
        },
      ]);
    }
    if (text.includes('from allrice_employee_instances i join')) {
      return Promise.resolve([f.instanceRow]);
    }
    if (text.includes('select s.employee_version_id'))
      return Promise.resolve([]);
    if (text.includes('select a.id,a.employee_version_id,a.employee_id')) {
      return Promise.resolve([f.assignmentRow]);
    }
    if (
      text.startsWith('select employee_id from allrice_employee_assignments')
    ) {
      return Promise.resolve([f.assignmentRow]);
    }
    if (text.includes('from allrice_employee_version_sources p')) {
      return Promise.resolve([]);
    }
    if (
      text.startsWith('select config_checksum') ||
      text.startsWith('select v.config_checksum')
    ) {
      return Promise.resolve([
        { config_checksum: runtimePolicyDigest('version') },
      ]);
    }
    if (text.startsWith('select * from allrice_employee_content_sets')) {
      return Promise.resolve([f.set]);
    }
    if (text.startsWith('select * from allrice_employee_content_revisions')) {
      return Promise.resolve([f.revision]);
    }
    if (text.startsWith('select s.*,r.manifest,r.digest')) {
      return Promise.resolve(
        options.missingReadLayer
          ? []
          : [
              {
                ...f.set,
                manifest: f.revision.manifest,
                digest: f.revision.digest,
              },
            ],
      );
    }
    if (text.includes('from allrice_company_assets a join')) {
      return Promise.resolve([f.assetRow]);
    }
    throw Error(`unexpected_sql_fixture_query: ${text}`);
  });
  return { sql: query as unknown as TransactionSql, statements };
}

function forbidPool() {
  return vi.spyOn(client, 'getDatabase').mockImplementation(() => {
    throw Error('unexpected_global_database');
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('employee runtime content preparation transaction forwarding', () => {
  it('shares the supplied transaction across freeze and read', async () => {
    const pool = forbidPool();
    const f = fixture();
    const tx = reader(f);
    const content = await prepareEmployeeRuntimeContent(
      f.context,
      f.input,
      tx.sql,
    );
    expect(pool).not.toHaveBeenCalled();
    expect(content.layers[0]?.common).toEqual([f.reference]);
    expect(
      tx.statements.some((text) =>
        text.includes('from allrice_company_assets a join'),
      ),
    ).toBe(true);
    const { checksum, ...index } = content;
    expect(checksum).toBe(runtimePolicyDigest(index));
    expect(JSON.stringify(content)).not.toContain(
      'TRANSACTION_CONTENT_SENTINEL',
    );
  });

  it('preserves separate default reader acquisition', async () => {
    const f = fixture();
    const freeze = reader(f);
    const read = reader(f);
    const pool = vi
      .spyOn(client, 'getDatabase')
      .mockReturnValueOnce(
        freeze.sql as unknown as ReturnType<typeof client.getDatabase>,
      )
      .mockReturnValueOnce(
        read.sql as unknown as ReturnType<typeof client.getDatabase>,
      );
    const content = await prepareEmployeeRuntimeContent(f.context, f.input);
    expect(pool).toHaveBeenCalledTimes(2);
    expect(content.layers[0]?.common).toEqual([f.reference]);
    expect(
      freeze.statements.some((text) =>
        text.includes('from allrice_company_assets a join'),
      ),
    ).toBe(false);
    expect(
      read.statements.some((text) =>
        text.includes('from allrice_company_assets a join'),
      ),
    ).toBe(true);
  });

  it('propagates freeze errors before the body read', async () => {
    const pool = forbidPool();
    const f = fixture();
    const error = Error('freeze_query_failed');
    const tx = reader(f, {
      failure: {
        includes: 'select employee_id from allrice_employee_assignments',
        error,
      },
    });
    await expect(
      prepareEmployeeRuntimeContent(f.context, f.input, tx.sql),
    ).rejects.toBe(error);
    expect(pool).not.toHaveBeenCalled();
    expect(
      tx.statements.some((text) =>
        text.startsWith('select s.*,r.manifest,r.digest'),
      ),
    ).toBe(false);
  });

  it('propagates read errors without a pool fallback', async () => {
    const pool = forbidPool();
    const f = fixture();
    const error = Error('read_query_failed');
    const tx = reader(f, {
      failure: { includes: 'select s.*,r.manifest,r.digest', error },
    });
    await expect(
      prepareEmployeeRuntimeContent(f.context, f.input, tx.sql),
    ).rejects.toBe(error);
    expect(pool).not.toHaveBeenCalled();
  });

  it('rejects unavailable content after freezing', async () => {
    const pool = forbidPool();
    const f = fixture();
    const tx = reader(f, { missingReadLayer: true });
    await expect(
      prepareEmployeeRuntimeContent(f.context, f.input, tx.sql),
    ).rejects.toMatchObject({
      code: 'EMPLOYEE_CONTENT_UNAVAILABLE',
    });
    expect(pool).not.toHaveBeenCalled();
  });
});
