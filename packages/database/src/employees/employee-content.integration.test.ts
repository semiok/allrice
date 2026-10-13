import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WorkflowDefinitionSchema } from '@allrice/contracts';
import type {
  EmployeeContentMutation,
  EmployeeContentReference,
  EmployeeContentReceipt,
  RequestContext,
} from '@allrice/contracts';
import * as client from '../core/client.ts';
import {
  createAssistantFixtureDatabase,
  assistantFixtureStorage,
} from '../assistant-runtime.fixture.ts';
import { createEmployeeAdministrationFixture } from '../employee-administration.fixture.ts';
import {
  authenticateSession,
  createSession,
  ensureBootstrapPortalPrincipal,
  revokeSession,
} from '../identity.ts';
import {
  createManagedOrganization,
  importOrganizationPeople,
} from '../organization-administration.ts';
import { createOrganizationDepartment } from '../organization-departments.ts';
import {
  listAdminTenantEmployees,
  changeAdminTenantEmployee,
} from '../tenant-employees.ts';
import { getEmployeeWorkspace } from '../workspace/service.ts';
import { createEmployeeInstance } from './employee-instances.ts';
import {
  getEffectiveEmployeeContent,
  getEmployeeContentSet,
  mutateEmployeeContent,
} from './employee-content.ts';
import {
  getCompanyAsset,
  listCompanyAssets,
  listCompanyAssetRevisions,
  mutateCompanyAsset,
} from '../company-assets.ts';
import { runtimePolicyDigest } from '../runtime-policy.ts';
const browser = vi.hoisted(() => ({ context: null as RequestContext | null }));
vi.mock('../../../../apps/web/lib/identity/session', () => ({
  getRequestContext: async () => browser.context,
}));

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'layered employee content: isolated transactions and current authority',
  () => {
    let f: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>,
      admin: RequestContext,
      publication: Awaited<
        ReturnType<typeof createEmployeeAdministrationFixture>
      >;
    beforeAll(async () => {
      f = await createAssistantFixtureDatabase();
      vi.spyOn(client, 'getDatabase').mockReturnValue(f.db);
      const p = await ensureBootstrapPortalPrincipal({
        organizationSlug: 'allrice-platform',
        organizationName: 'Platform',
        workspaceSlug: 'default',
        workspaceName: 'Default',
        email: 'content-platform@example.test',
        displayName: 'Platform',
        role: 'member',
      });
      vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', p.user.email);
      admin = (await authenticateSession(
        (await createSession(p.user.id)).token,
      ))!;
      publication = await createEmployeeAdministrationFixture(f.db);
      await publication.preview();
      expect((await publication.publish()).valid).toBe(true);
    }, 120000);
    afterAll(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await f?.close();
    }, 30000);
    async function setup() {
      const created = await createManagedOrganization(admin, {
        name: `Content-${randomUUID()}`,
      });
      const company = { ...created, workspaceId: created.defaultWorkspaceId! };
      const dept = (
        await createOrganizationDepartment(admin, company.organizationId, {
          name: 'Research',
          requestId: randomUUID(),
        })
      ).department;
      const otherDept = (
        await createOrganizationDepartment(admin, company.organizationId, {
          name: 'Finance',
          requestId: randomUUID(),
        })
      ).department;
      const people = (
        await importOrganizationPeople(admin, company.organizationId, {
          people: [
            {
              username: `owner-${randomUUID()}`,
              displayName: 'Owner',
              departmentId: dept.id,
              contentMaintenanceLevel: 'company',
            },
            {
              username: `peer-${randomUUID()}`,
              displayName: 'Peer',
              departmentId: dept.id,
              contentMaintenanceLevel: 'personal',
            },
            {
              username: `other-${randomUUID()}`,
              displayName: 'Other',
              departmentId: otherDept.id,
              contentMaintenanceLevel: 'department',
            },
          ],
        })
      ).created;
      const contexts: RequestContext[] = [],
        tokens: string[] = [];
      for (const person of people) {
        const login = await createSession(person.userId);
        tokens.push(login.token);
        contexts.push(
          (await authenticateSession(login.token, {
            organizationId: company.organizationId,
            workspaceId: company.workspaceId,
          }))!,
        );
      }
      const [a, b, c] = contexts as [
        RequestContext,
        RequestContext,
        RequestContext,
      ];
      const employee = (
        await listAdminTenantEmployees(
          admin,
          company.organizationId,
          company.workspaceId,
        )
      ).employees.find((e) => e.employeeId === publication.employeeId)!;
      await changeAdminTenantEmployee(admin, company.organizationId, {
        workspaceId: company.workspaceId,
        employeeId: publication.employeeId,
        action: 'assign',
        revisionId: employee.revisionId,
        expectedVersion: employee.deployment?.version ?? null,
      });
      const assigned = (
        await getEmployeeWorkspace(a, company.workspaceId)
      ).employees.find((e) => e.employeeKey === publication.definition.key)!;
      const [assignmentRow] = await f.db<
        { employee_id: string }[]
      >`select employee_id from allrice_employee_assignments where id=${assigned.id}`;
      const instance = await createEmployeeInstance(a, {
        workspaceId: company.workspaceId,
        assignmentId: assigned.id,
        requestId: randomUUID(),
        profile: { name: 'Research assistant' },
      });
      const base = {
        workspaceId: company.workspaceId,
        setId: randomUUID(),
        ownership: {
          scope: 'personal' as const,
          organizationId: company.organizationId,
          ownerId: a.actor.id,
        },
        target: { kind: 'instance' as const, instanceId: instance.id },
        requestId: randomUUID(),
        expectedRevision: 0,
        changeSummary: 'Fixed synthetic content',
      };
      const draft = (
        extra: Partial<
          Extract<EmployeeContentMutation, { operation: 'save_draft' }>
        > = {},
      ): Extract<EmployeeContentMutation, { operation: 'save_draft' }> => ({
        ...base,
        requestId: randomUUID(),
        operation: 'save_draft',
        manifest: {
          schemaVersion: 1,
          common: [],
          scenes: [],
          declaredConflicts: [],
        },
        textEdits: [],
        ...extra,
      });
      return {
        company,
        dept,
        otherDept,
        a,
        b,
        c,
        assigned,
        instance,
        employeeId: assignmentRow!.employee_id,
        base,
        draft,
        tokens,
      };
    }
    type Setup = Awaited<ReturnType<typeof setup>>;
    async function knowledge(
      s: Setup,
      name: string,
      acl: 'workspace' | 'user' | 'employee' = 'workspace',
    ) {
      const sourceId = randomUUID(),
        revisionId = randomUUID(),
        bindingId = randomUUID();
      const definition = {
        schemaVersion: 1,
        sourceKind: 'managed',
        connectorBindingId: null,
        resourceRef: `synthetic:${name}`,
        indexing: 'none',
        updatePolicy: 'manual',
        citationRequired: true,
        allowedScopes: ['workspace'],
      };
      const checksum = runtimePolicyDigest(definition);
      await f.db`insert into allrice_knowledge_sources(id,organization_id,workspace_id,slug,name,description,created_by)
      values(${sourceId},${s.company.organizationId},${s.company.workspaceId},${`source-${sourceId}`},${name},${name},${s.a.actor.id})`;
      await f.db`insert into allrice_knowledge_revisions(id,organization_id,workspace_id,knowledge_source_id,revision,name,description,status,definition,checksum,created_by)
      values(${revisionId},${s.company.organizationId},${s.company.workspaceId},${sourceId},1,${name},${name},'draft',${f.db.json(definition)},${checksum},${s.a.actor.id})`;
      await f.db`insert into allrice_knowledge_acl_entries(organization_id,workspace_id,knowledge_revision_id,principal_type,principal_id,permission)
      values(${s.company.organizationId},${s.company.workspaceId},${revisionId},${acl},${acl === 'user' ? s.a.actor.id : acl === 'employee' ? s.employeeId : s.company.workspaceId},'read')`;
      await f.db`update allrice_knowledge_revisions set status='published',published_at=now() where id=${revisionId}`;
      await f.db`insert into allrice_employee_knowledge_bindings(id,organization_id,workspace_id,employee_id,knowledge_revision_id,bound_by)
      values(${bindingId},${s.company.organizationId},${s.company.workspaceId},${s.employeeId},${revisionId},${s.a.actor.id})`;
      return {
        ref: {
          sourceKind: 'knowledge' as const,
          contentId: sourceId,
          revisionId,
          digest: checksum,
        },
        bindingId,
      };
    }
    function text(body = 'Preserve source values; show calculations.') {
      return {
        contentId: randomUUID(),
        revisionId: randomUUID(),
        expectedRevision: 0,
        kind: 'requirement' as const,
        title: 'Common rule',
        body,
      };
    }
    function action(
      input: EmployeeContentMutation,
      receipt: EmployeeContentReceipt,
      operation: 'validate' | 'activate',
    ): EmployeeContentMutation {
      return {
        workspaceId: input.workspaceId,
        setId: input.setId,
        ownership: input.ownership,
        target: input.target,
        expectedRevision: receipt.revision,
        requestId: randomUUID(),
        changeSummary: operation,
        operation,
        candidateRevisionId: receipt.candidate.id,
        candidateDigest: receipt.candidate.digest,
      };
    }
    async function enable(s: Setup, input: EmployeeContentMutation) {
      const saved = await mutateEmployeeContent(s.a, input),
        check = await mutateEmployeeContent(
          s.a,
          action(input, saved, 'validate'),
        );
      expect(check.validation?.valid).toBe(true);
      return mutateEmployeeContent(s.a, action(input, check, 'activate'));
    }
    it('saves two scenes with a shared rule and distinct native Knowledge; activates the exact immutable candidate', async () => {
      const s = await setup(),
        k1 = await knowledge(s, 'Weekly sources'),
        k2 = await knowledge(s, 'Monthly sources'),
        rule = text();
      const input = s.draft({
        textEdits: [rule],
        manifest: {
          schemaVersion: 1,
          common: [{ sourceKind: 'draft_text', contentId: rule.contentId }],
          scenes: [
            {
              id: randomUUID(),
              name: 'Weekly',
              appliesWhen: 'Weekly research',
              references: [k1.ref],
            },
            {
              id: randomUUID(),
              name: 'Monthly',
              appliesWhen: 'Monthly research',
              references: [k2.ref],
            },
          ],
          declaredConflicts: [],
        },
      });
      const saved = await mutateEmployeeContent(s.a, input);
      expect(
        (await getEffectiveEmployeeContent(s.a, s.instance.id)).scenes,
      ).toEqual([]);
      expect(
        (await getEmployeeContentSet(s.a, input.setId)).sources.find(
          (r) => r.reference.contentId === rule.contentId,
        )?.body,
      ).toBe(rule.body);
      const checked = await mutateEmployeeContent(
        s.a,
        action(input, saved, 'validate'),
      );
      expect(checked.validation).toMatchObject({
        valid: true,
        semanticConsistency: 'not_proven',
      });
      const activated = await mutateEmployeeContent(
        s.a,
        action(input, checked, 'activate'),
      );
      expect(activated.active).toEqual(saved.candidate);
      const effective = await getEffectiveEmployeeContent(s.a, s.instance.id);
      expect(effective.validation.valid).toBe(true);
      expect(effective.scenes.map((v) => v.name)).toEqual([
        'Weekly',
        'Monthly',
      ]);
      expect(effective.common).toHaveLength(1);
      expect(effective.sources).toHaveLength(3);
      expect(effective.platform.revisionId).toBe(publication.revisionId);
      expect(effective.platform.requirements).toContain(
        'No implicit authority',
      );
      await expect(
        f.db`update allrice_employee_content_revisions set manifest='{}' where id=${saved.candidate.id}`,
      ).rejects.toThrow('immutable');
      await expect(
        f.db`update allrice_employee_content_sets set owner_id=${s.b.actor.id} where id=${input.setId}`,
      ).rejects.toThrow('immutable');
    });
    it('replays original receipts after later changes, rejects reused request IDs and atomically loses a concurrent stale edit', async () => {
      const s = await setup(),
        input = s.draft();
      const receipts = await Promise.all(
        [1, 2, 3].map(() => mutateEmployeeContent(s.a, input)),
      );
      expect(receipts[1]).toEqual(receipts[0]);
      expect(receipts[2]).toEqual(receipts[0]);
      const checked = await mutateEmployeeContent(
        s.a,
        action(input, receipts[0]!, 'validate'),
      );
      expect(await mutateEmployeeContent(s.a, input)).toEqual(receipts[0]);
      await expect(
        mutateEmployeeContent(s.a, { ...input, changeSummary: 'different' }),
      ).rejects.toMatchObject({ code: 'request_conflict' });
      const edits = [text('First'), text('Second')];
      const updates = edits.map((t) => ({
        ...input,
        requestId: randomUUID(),
        expectedRevision: checked.revision,
        textEdits: [t],
        manifest: {
          ...input.manifest,
          common: [
            { sourceKind: 'draft_text' as const, contentId: t.contentId },
          ],
        },
      }));
      const results = await Promise.allSettled(
        updates.map((i) => mutateEmployeeContent(s.a, i)),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
      const assets =
        await f.db`select id from allrice_company_assets where id in ${f.db(edits.map((e) => e.contentId))}`;
      expect(assets).toHaveLength(1);
      await expect(
        mutateEmployeeContent(s.a, {
          ...input,
          setId: randomUUID(),
          requestId: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'version_conflict' });
    });
    it('a revoked dependency prevents activation and preserves the prior active version; fresh reads redact it', async () => {
      const s = await setup(),
        input = s.draft(),
        active = await enable(s, input),
        k = await knowledge(s, 'revocable');
      const next = {
        ...input,
        requestId: randomUUID(),
        expectedRevision: active.revision,
        manifest: { ...input.manifest, common: [k.ref] },
      };
      const saved = await mutateEmployeeContent(s.a, next),
        checked = await mutateEmployeeContent(
          s.a,
          action(next, saved, 'validate'),
        );
      await f.db`update allrice_employee_knowledge_bindings set enabled=false where id=${k.bindingId}`;
      await expect(
        mutateEmployeeContent(s.a, action(next, checked, 'activate')),
      ).rejects.toMatchObject({ code: 'validation_failed' });
      expect(
        (await getEmployeeContentSet(s.a, input.setId)).set.active?.id,
      ).toBe(active.active?.id);
      expect(
        (await getEmployeeContentSet(s.a, input.setId)).sources[0],
      ).toMatchObject({ available: false });
      expect(
        (await getEmployeeContentSet(s.a, input.setId)).sources[0],
      ).not.toHaveProperty('body');
      expect(
        await f.db`select id from allrice_employee_content_requests where set_id=${input.setId}`,
      ).toHaveLength(5);
    });
    it('private content cannot enter the old company directory, historical source reader, or mutation API', async () => {
      const s = await setup(),
        rule = text('Owner-only detail'),
        input = s.draft({
          textEdits: [rule],
          manifest: {
            schemaVersion: 1,
            common: [{ sourceKind: 'draft_text', contentId: rule.contentId }],
            scenes: [],
            declaredConflicts: [],
          },
        });
      await enable(s, input);
      expect(
        (await listCompanyAssets(s.a, s.company.organizationId)).assets,
      ).toEqual([]);
      expect(
        (await listCompanyAssets(s.b, s.company.organizationId)).assets,
      ).toEqual([]);
      for (const ctx of [s.a, s.b, admin]) {
        const administration = ctx === admin;
        await expect(
          getCompanyAsset(
            ctx,
            s.company.organizationId,
            rule.contentId,
            administration,
          ),
        ).rejects.toThrow();
        await expect(
          listCompanyAssetRevisions(
            ctx,
            s.company.organizationId,
            rule.contentId,
            administration,
          ),
        ).rejects.toThrow();
        await expect(
          mutateCompanyAsset(
            ctx,
            s.company.organizationId,
            {
              assetId: rule.contentId,
              operation: 'archive',
              expectedRevision: 2,
            },
            assistantFixtureStorage(f.db),
            administration,
          ),
        ).rejects.toMatchObject({ code: 'not_found' });
      }
      await expect(getEmployeeContentSet(s.b, input.setId)).rejects.toThrow();
      await expect(getEmployeeContentSet(admin, input.setId)).rejects.toThrow();
    });
    it('inherits company and department rules; private edits cannot overwrite them or silently lose an upstream change', async () => {
      const s = await setup(),
        rule = text('Company source requirements');
      const company = s.draft({
        setId: randomUUID(),
        ownership: {
          scope: 'company',
          organizationId: s.company.organizationId,
        },
        target: { kind: 'employee', employeeId: s.employeeId },
        textEdits: [rule],
        manifest: {
          schemaVersion: 1,
          common: [{ sourceKind: 'draft_text', contentId: rule.contentId }],
          scenes: [],
          declaredConflicts: [],
        },
      });
      const enabled = await enable(s, company);
      const departmental = text('Research output includes provenance');
      const dept = s.draft({
        ...company,
        setId: randomUUID(),
        requestId: randomUUID(),
        ownership: {
          scope: 'department',
          organizationId: s.company.organizationId,
          departmentId: s.dept.id,
        },
        textEdits: [departmental],
        manifest: {
          ...company.manifest,
          common: [
            { sourceKind: 'draft_text', contentId: departmental.contentId },
          ],
        },
      });
      await enable(s, dept);
      const own = s.draft(),
        saved = await mutateEmployeeContent(s.a, own),
        validated = await mutateEmployeeContent(
          s.a,
          action(own, saved, 'validate'),
        );
      const changedRule = {
        ...rule,
        revisionId: randomUUID(),
        expectedRevision: 2,
        body: 'New company requirements',
      };
      const changed = {
        ...company,
        expectedRevision: enabled.revision,
        requestId: randomUUID(),
        textEdits: [changedRule],
      };
      await enable(s, changed);
      await expect(
        mutateEmployeeContent(s.a, action(own, validated, 'activate')),
      ).rejects.toMatchObject({ code: 'source_changed' });
      const revalidated = await mutateEmployeeContent(
        s.a,
        action(own, validated, 'validate'),
      );
      await mutateEmployeeContent(s.a, action(own, revalidated, 'activate'));
      const effective = await getEffectiveEmployeeContent(s.a, s.instance.id);
      expect(effective.common).toHaveLength(2);
      expect(effective.sources.map((x) => x.body)).toEqual(
        expect.arrayContaining(['New company requirements', departmental.body]),
      );
      const ownState = await getEmployeeContentSet(s.a, own.setId);
      await expect(
        mutateEmployeeContent(
          s.a,
          s.draft({
            requestId: randomUUID(),
            expectedRevision: ownState.set.revision,
            textEdits: [{ ...changedRule, expectedRevision: 4 }],
            manifest: {
              ...own.manifest,
              common: [{ sourceKind: 'draft_text', contentId: rule.contentId }],
            },
          }),
        ),
      ).rejects.toMatchObject({ code: 'not_found' });
      // Both old and new immutable publications still exist. A lower reference
      // to an old version must conflict with the new inherited version.
      const oldRef: EmployeeContentReference = {
        sourceKind: 'requirement',
        contentId: rule.contentId,
        revisionId: rule.revisionId,
        digest: runtimePolicyDigest({
          kind: rule.kind,
          title: rule.title,
          body: rule.body,
        }),
      };
      const conflicting = s.draft({
        requestId: randomUUID(),
        expectedRevision: ownState.set.revision,
        manifest: { ...own.manifest, common: [oldRef] },
      });
      const pending = await mutateEmployeeContent(s.a, conflicting),
        check = await mutateEmployeeContent(
          s.a,
          action(conflicting, pending, 'validate'),
        );
      expect(
        check.validation?.issues.some(
          (x) => x.code === 'mandatory_rule_conflict',
        ),
      ).toBe(true);
      await expect(
        mutateEmployeeContent(s.a, action(conflicting, check, 'activate')),
      ).rejects.toMatchObject({ code: 'validation_required' });
    });
    it('shared source drafts stay hidden from ordinary readers and user-only or employee-only Knowledge cannot be promoted', async () => {
      const s = await setup(),
        k = await knowledge(s, 'Owner ACL', 'user');
      const company = s.draft({
        setId: randomUUID(),
        ownership: {
          scope: 'company',
          organizationId: s.company.organizationId,
        },
        target: { kind: 'employee', employeeId: s.employeeId },
      });
      const active = await enable(s, company),
        rule = text('Unpublished company draft');
      const next = {
        ...company,
        requestId: randomUUID(),
        expectedRevision: active.revision,
        textEdits: [rule],
        manifest: {
          ...company.manifest,
          common: [
            { sourceKind: 'draft_text' as const, contentId: rule.contentId },
            k.ref,
          ],
        },
      };
      const saved = await mutateEmployeeContent(s.a, next);
      const peer = await getEmployeeContentSet(s.b, company.setId);
      expect(peer.set.candidate).toBeNull();
      expect(peer.sources).toEqual([]);
      const checked = await mutateEmployeeContent(
        s.a,
        action(next, saved, 'validate'),
      );
      expect(checked.validation?.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'source_scope_mismatch',
            contentId: k.ref.contentId,
          }),
        ]),
      );
      // A new immutable ACL revision grants only the AI employee. It is valid
      // in its owner's instance, but is not a general company-reader grant.
      const employeeOnly = await knowledge(s, 'Employee ACL', 'employee');
      const employeeDraft = {
        ...company,
        requestId: randomUUID(),
        expectedRevision: checked.revision,
        manifest: { ...company.manifest, common: [employeeOnly.ref] },
      };
      const es = await mutateEmployeeContent(s.a, employeeDraft),
        ec = await mutateEmployeeContent(
          s.a,
          action(employeeDraft, es, 'validate'),
        );
      expect(
        ec.validation?.issues.some((x) => x.code === 'source_scope_mismatch'),
      ).toBe(true);
      const personal = s.draft({
        manifest: { ...company.manifest, common: [employeeOnly.ref] },
      });
      expect((await enable(s, personal)).active).not.toBeNull();
    });
    it('rechecks current department, maintenance, assignment and login before reads, writes, or idempotent replay', async () => {
      const s = await setup(),
        dept = s.draft({
          setId: randomUUID(),
          ownership: {
            scope: 'department',
            organizationId: s.company.organizationId,
            departmentId: s.dept.id,
          },
          target: { kind: 'employee', employeeId: s.employeeId },
        });
      const state = await enable(s, dept);
      expect(
        (await getEmployeeContentSet(s.b, dept.setId)).set.access.canRead,
      ).toBe(true);
      await expect(getEmployeeContentSet(s.c, dept.setId)).rejects.toThrow();
      await f.db`update allrice_organization_people set department_id=${s.otherDept.id} where organization_id=${s.company.organizationId} and user_id=${s.b.actor.id}`;
      await expect(getEmployeeContentSet(s.b, dept.setId)).rejects.toThrow();
      await f.db`update allrice_organization_people set content_maintenance_level='personal' where organization_id=${s.company.organizationId} and user_id=${s.a.actor.id}`;
      await expect(mutateEmployeeContent(s.a, dept)).rejects.toMatchObject({
        code: 'authorization_denied',
      });
      await expect(
        mutateEmployeeContent(s.a, action(dept, state, 'validate')),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      const own = s.draft(),
        saved = await mutateEmployeeContent(s.a, own);
      await f.db`update allrice_employee_assignments set active=false where id=${s.assigned.id}`;
      await expect(mutateEmployeeContent(s.a, own)).rejects.toMatchObject({
        code: 'authorization_denied',
      });
      await f.db`update allrice_employee_assignments set active=true where id=${s.assigned.id}`;
      await revokeSession(s.tokens[0]!);
      await expect(
        mutateEmployeeContent(s.a, action(own, saved, 'validate')),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      await expect(getEmployeeContentSet(s.a, own.setId)).rejects.toThrow();
    });
    it('a failed activation never publishes staged text and declared conflicts remain blocking', async () => {
      const s = await setup(),
        rule = text(),
        k = await knowledge(s, 'Temporarily available');
      const input = s.draft({
        textEdits: [rule],
        manifest: {
          schemaVersion: 1,
          common: [
            { sourceKind: 'draft_text', contentId: rule.contentId },
            k.ref,
          ],
          scenes: [],
          declaredConflicts: [],
        },
      });
      const saved = await mutateEmployeeContent(s.a, input),
        checked = await mutateEmployeeContent(
          s.a,
          action(input, saved, 'validate'),
        );
      await f.db`update allrice_knowledge_sources set status='archived' where id=${k.ref.contentId}`;
      await expect(
        mutateEmployeeContent(s.a, action(input, checked, 'activate')),
      ).rejects.toThrow();
      expect(
        await f.db`select * from allrice_company_asset_publications where asset_id=${rule.contentId}`,
      ).toHaveLength(0);
      expect(
        (await getEmployeeContentSet(s.a, input.setId)).set.active,
      ).toBeNull();
      const declared = {
        ...input,
        expectedRevision: checked.revision,
        requestId: randomUUID(),
        textEdits: [],
        manifest: {
          schemaVersion: 1 as const,
          common: [],
          scenes: [],
          declaredConflicts: [
            {
              contentIds: [rule.contentId],
              reason: 'Two different accounting bases',
            },
          ],
        },
      };
      const pending = await mutateEmployeeContent(s.a, declared),
        check = await mutateEmployeeContent(
          s.a,
          action(declared, pending, 'validate'),
        );
      expect(
        check.validation?.issues.some((x) => x.code === 'declared_conflict'),
      ).toBe(true);
    });
    const gate = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      return { resolve, promise };
    };
    it('does not invert publication employee→assignment locks during candidate validation', async () => {
      const s = await setup(),
        input = s.draft(),
        saved = await mutateEmployeeContent(s.a, input),
        request = action(input, saved, 'validate');
      const locked = gate(),
        proceed = gate();
      const publicationWrite = f.db.begin(async (tx) => {
        await tx`select id from allrice_employees where id=${s.employeeId} for no key update`;
        locked.resolve();
        await proceed.promise;
        await tx`update allrice_employee_assignments set updated_at=clock_timestamp() where id=${s.assigned.id}`;
      });
      void publicationWrite.catch(() => undefined);
      await locked.promise;
      const validation = mutateEmployeeContent(s.a, request);
      void validation.catch(() => undefined);
      try {
        await expect
          .poll(
            async () =>
              (
                await f.db`select id from allrice_employee_content_requests where request_id=${request.requestId}`
              ).length,
            { timeout: 3000, interval: 20 },
          )
          .toBe(1);
      } finally {
        proceed.resolve();
      }
      expect(
        (await Promise.allSettled([validation, publicationWrite])).map(
          (r) => r.status,
        ),
      ).toEqual(['fulfilled', 'fulfilled']);
    });
    it('serializes shared validation with deployment→employee withdrawal without adding the reverse lock', async () => {
      const s = await setup(),
        input = s.draft({
          ownership: {
            scope: 'company',
            organizationId: s.company.organizationId,
          },
          target: { kind: 'employee', employeeId: s.employeeId },
        });
      const saved = await mutateEmployeeContent(s.a, input),
        locked = gate(),
        proceed = gate();
      const withdrawal = f.db.begin(async (tx) => {
        await tx`update allrice_platform_employee_tenant_assignments set active=false where tenant_employee_id=${s.employeeId}`;
        locked.resolve();
        await proceed.promise;
        await tx`update allrice_employees set status='archived' where id=${s.employeeId}`;
      });
      void withdrawal.catch(() => undefined);
      await locked.promise;
      const validation = mutateEmployeeContent(
        s.a,
        action(input, saved, 'validate'),
      );
      void validation.catch(() => undefined);
      try {
        await expect
          .poll(
            async () =>
              (
                await f.db`select pid from pg_stat_activity where datname=current_database()
        and wait_event_type='Lock' and query like '%select active,tenant_employee_version_id%'`
              ).length,
            { timeout: 3000, interval: 20 },
          )
          .toBeGreaterThan(0);
      } finally {
        proceed.resolve();
      }
      await expect(withdrawal).resolves.toBeUndefined();
      await expect(validation).rejects.toMatchObject({ code: 'not_found' });
      expect(
        (
          await f.db`select revision from allrice_employee_content_sets where id=${input.setId}`
        )[0]?.revision,
      ).toBe(saved.revision);
    });
    it('HTTP save→validate→activate→effective details preserves DTOs, source checks and browser write boundaries', async () => {
      // Load the Next entrypoints at runtime; the database's NodeNext typecheck
      // must not pull the Web bundler's extensionless imports into its project.
      const writePath =
        '../../../../apps/web/app/api/v1/employee-content/route.ts';
      const readPath =
        '../../../../apps/web/app/api/v1/employee-instances/[id]/content/route.ts';
      const { POST: postContent } = (await import(writePath)) as {
        POST: (request: Request) => Promise<Response>;
      };
      const { GET: readContentRoute } = (await import(readPath)) as {
        GET: (
          request: Request,
          options: { params: Promise<{ id: string }> },
        ) => Promise<Response>;
      };
      const s = await setup(),
        rule = text('HTTP-visible exact content'),
        input = s.draft({
          textEdits: [rule],
          manifest: {
            schemaVersion: 1,
            common: [{ sourceKind: 'draft_text', contentId: rule.contentId }],
            scenes: [],
            declaredConflicts: [],
          },
        });
      browser.context = s.a;
      const request = (body: unknown, origin = 'https://allrice.test') =>
        new Request('https://allrice.test/api/v1/employee-content', {
          method: 'POST',
          headers: { origin, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      expect(
        (await postContent(request(input, 'https://foreign.test'))).status,
      ).toBe(403);
      expect(
        (await postContent(request({ ...input, tools: ['anything'] }))).status,
      ).toBe(400);
      const saved = await postContent(request(input));
      expect(saved.status).toBe(200);
      const savedBody = (await saved.json()) as {
        receipt: EmployeeContentReceipt;
      };
      const checked = await postContent(
        request(action(input, savedBody.receipt, 'validate')),
      );
      expect(checked.status).toBe(200);
      const checkedBody = (await checked.json()) as {
        receipt: EmployeeContentReceipt;
      };
      expect(
        (
          await postContent(
            request(action(input, checkedBody.receipt, 'activate')),
          )
        ).status,
      ).toBe(200);
      const read = () =>
        readContentRoute(
          new Request(
            `https://allrice.test/api/v1/employee-instances/${s.instance.id}/content?workspaceId=${s.company.workspaceId}`,
          ),
          { params: Promise.resolve({ id: s.instance.id }) },
        );
      const actual = await read();
      expect(actual.status).toBe(200);
      expect((await actual.json()).content.sources[0].body).toBe(rule.body);
      browser.context = s.b;
      expect((await read()).status).toBe(404);
      browser.context = null;
      expect((await read()).status).toBe(401);
    });
    it('existing workflow bindings and current confirmed memories remain independent authority boundaries', async () => {
      const s = await setup(),
        workflowId = randomUUID(),
        workflowRevisionId = randomUUID(),
        memoryId = randomUUID(),
        memoryRevisionId = randomUUID();
      const workflowDefinition = WorkflowDefinitionSchema.parse({
        schemaVersion: 1,
        steps: [
          { key: 'read', name: 'Read authorized sources', kind: 'knowledge' },
        ],
      });
      const workflowDigest = runtimePolicyDigest(workflowDefinition);
      await f.db`insert into allrice_workflows(id,organization_id,workspace_id,slug,name,description,created_by)
      values(${workflowId},${s.company.organizationId},${s.company.workspaceId},${`flow-${workflowId}`},'Existing workflow','Already managed by the capability registry',${s.a.actor.id})`;
      await f.db`insert into allrice_workflow_revisions(id,organization_id,workspace_id,workflow_id,revision,name,description,definition,checksum,created_by,published_at)
      values(${workflowRevisionId},${s.company.organizationId},${s.company.workspaceId},${workflowId},1,'Existing workflow','Reviewed steps',${f.db.json(workflowDefinition)},${workflowDigest},${s.a.actor.id},now())`;
      await f.db`insert into allrice_employee_workflow_bindings(organization_id,workspace_id,employee_id,workflow_revision_id,bound_by)
      values(${s.company.organizationId},${s.company.workspaceId},${s.employeeId},${workflowRevisionId},${s.a.actor.id})`;
      const body = 'Use the original data dictionary.';
      await f.db`insert into allrice_memories(id,organization_id,workspace_id,employee_id,owner_id,content)
      values(${memoryId},${s.company.organizationId},${s.company.workspaceId},${s.employeeId},${s.a.actor.id},${body})`;
      await f.db`insert into allrice_memory_revisions(id,organization_id,workspace_id,memory_id,revision,content,trust_level,confidence,reason,changed_by)
      values(${memoryRevisionId},${s.company.organizationId},${s.company.workspaceId},${memoryId},1,${body},'user_confirmed',1,'Confirmed fixture',${s.a.actor.id})`;
      const memoryRef: EmployeeContentReference = {
        sourceKind: 'experience',
        contentId: memoryId,
        revisionId: memoryRevisionId,
        digest: runtimePolicyDigest({
          memoryId,
          revisionId: memoryRevisionId,
          revision: 1,
          content: body,
        }),
      };
      const procedure = {
        ...text('Read input, check assumptions, then prepare the report.'),
        kind: 'procedure' as const,
      };
      const input = s.draft({
        textEdits: [procedure],
        manifest: {
          schemaVersion: 1,
          common: [memoryRef],
          scenes: [
            {
              id: randomUUID(),
              name: 'Review',
              appliesWhen: 'Review supplied data',
              references: [
                {
                  sourceKind: 'workflow',
                  contentId: workflowId,
                  revisionId: workflowRevisionId,
                  digest: workflowDigest,
                },
                { sourceKind: 'draft_text', contentId: procedure.contentId },
              ],
            },
          ],
          declaredConflicts: [],
        },
      });
      await enable(s, input);
      expect(
        (await getEffectiveEmployeeContent(s.a, s.instance.id)).sources.every(
          (x) => x.available,
        ),
      ).toBe(true);
      await f.db`update allrice_employee_workflow_bindings set enabled=false where workflow_revision_id=${workflowRevisionId}`;
      await f.db`update allrice_memories set lifecycle_state='candidate',trust_level='derived' where id=${memoryId}`;
      const effective = await getEffectiveEmployeeContent(s.a, s.instance.id);
      expect(effective.validation.valid).toBe(false);
      for (const id of [workflowId, memoryId]) {
        const source = effective.sources.find(
          (x) => x.reference.contentId === id,
        )!;
        expect(source.available).toBe(false);
        expect(source).not.toHaveProperty('body');
      }
      expect(
        effective.sources.find(
          (x) => x.reference.contentId === procedure.contentId,
        )?.body,
      ).toBe(procedure.body);
    });
  },
);
