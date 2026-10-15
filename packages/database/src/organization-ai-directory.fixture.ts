/** Synthetic data shared by database and browser acceptance. No production
 * entry point imports this fixture; no model or external service is called. */
import { randomUUID } from 'node:crypto';
import type {
  EmployeeContentMutation,
  EmployeeContentReference,
  RequestContext,
} from '@allrice/contracts';
import type { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';
import { assistantFixtureStorage } from './assistant-runtime.fixture.ts';
import { createEmployeeAdministrationFixture } from './employee-administration.fixture.ts';
import {
  createManagedOrganization,
  importOrganizationPeople,
} from './organization-administration.ts';
import { createOrganizationDepartment } from './organization-departments.ts';
import { authenticateSession, createSession } from './identity.ts';
import {
  listAdminTenantEmployees,
  changeAdminTenantEmployee,
} from './tenant-employees.ts';
import { getEmployeeWorkspace } from './workspace/service.ts';
import {
  createEmployeeInstance,
  listEmployeeInstances,
} from './employees/employee-instances.ts';
import { mutateEmployeeContent } from './employees/employee-content.ts';
import {
  prepareReferenceUpload,
  completeReferenceUpload,
} from './reference-library.ts';
import {
  claimReferenceProcessing,
  finishReferenceProcessing,
} from './reference-processing.ts';
import { captureReferenceSelections } from './reference-runtime.ts';

export async function createOrganizationAiDirectoryFixture(
  db: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>['db'],
  admin: RequestContext,
) {
  const company = await createManagedOrganization(admin, {
    name: `工作沉淀-${randomUUID()}`,
  });
  const workspaceId = company.defaultWorkspaceId;
  const department = async (name: string) =>
    (
      await createOrganizationDepartment(admin, company.organizationId, {
        name,
        requestId: randomUUID(),
      })
    ).department;
  const research = await department('科研部'),
    finance = await department('财务部');
  const people = (
    await importOrganizationPeople(admin, company.organizationId, {
      people: [
        {
          username: `directory-${randomUUID()}`,
          displayName: '研究员甲',
          departmentId: research.id,
          contentMaintenanceLevel: 'company',
        },
        {
          username: `directory-${randomUUID()}`,
          displayName: '财务乙',
          departmentId: finance.id,
        },
        { username: `directory-${randomUUID()}`, displayName: '未分部门员工' },
      ],
    })
  ).created;
  const contexts: RequestContext[] = [];
  for (const person of people)
    contexts.push(
      (await authenticateSession((await createSession(person.userId)).token, {
        organizationId: company.organizationId,
        workspaceId,
      }))!,
    );
  const owner = contexts[0]!;
  const publication = await createEmployeeAdministrationFixture(db, {
    name: `工作沉淀样例 ${randomUUID()}`,
  });
  await publication.preview();
  if (!(await publication.publish()).valid)
    throw Error('fixture_publication_failed');
  const employee = (
    await listAdminTenantEmployees(admin, company.organizationId, workspaceId)
  ).employees.find((e) => e.employeeId === publication.employeeId)!;
  await changeAdminTenantEmployee(admin, company.organizationId, {
    workspaceId,
    employeeId: publication.employeeId,
    action: 'assign',
    revisionId: employee.revisionId,
    expectedVersion: employee.deployment?.version ?? null,
  });
  for (const context of contexts)
    await getEmployeeWorkspace(context, workspaceId);
  const general = (await listEmployeeInstances(owner, workspaceId))[0]!;
  const [assignment] =
    await db`select employee_id from allrice_employee_assignments where id=${general.assignmentId}`;
  const employeeId = String(assignment!.employee_id);
  const custom = await createEmployeeInstance(owner, {
    workspaceId,
    assignmentId: general.assignmentId,
    requestId: randomUUID(),
    profile: {
      name: 'PRIVATE_NAME_SENTINEL',
      description: 'PRIVATE_DESCRIPTION_SENTINEL',
      role: 'PRIVATE_ROLE_SENTINEL',
      expressionStyle: 'concise',
    },
  });
  const upload = async (
    scope: 'company' | 'personal',
    fileName: string,
    sourceId?: string,
  ) => {
    const body = `固定参考资料 ${fileName}`;
    const prepared = await prepareReferenceUpload(owner, {
      workspaceId,
      requestId: randomUUID(),
      scope,
      fileName,
      purpose: body,
      mediaType: 'text/plain',
      contentBase64: Buffer.from(body).toString('base64'),
      ...(sourceId ? { sourceId, expectedRevision: 1 } : {}),
    });
    await assistantFixtureStorage(db).put(
      prepared.object,
      new Blob([new Uint8Array(prepared.bytes)]).stream(),
    );
    await completeReferenceUpload(owner, workspaceId, prepared.revisionId);
    const claim = await claimReferenceProcessing();
    if (claim?.revisionId !== prepared.revisionId)
      throw Error('fixture_reference_claim');
    await finishReferenceProcessing(claim, [
      { content: body, start: 0, end: body.length },
    ]);
    const [selection] = await db.begin((tx) =>
      captureReferenceSelections(owner, [prepared.revisionId], tx),
    );
    const ref: EmployeeContentReference = {
      sourceKind: 'knowledge',
      contentId: selection!.sourceId,
      revisionId: selection!.revisionId,
      digest: selection!.digest,
    };
    return { ...prepared, ref };
  };
  const sharedFile = await upload('company', '共享资料-v1.txt');
  const privateFile = await upload('personal', 'PRIVATE_FILENAME_SENTINEL.txt');
  const publish = async (
    scope: 'company' | 'personal' | { departmentId: string },
    marker: string,
    references: EmployeeContentReference[] = [],
  ) => {
    const contentId = randomUUID(),
      revisionId = randomUUID();
    const input: Extract<EmployeeContentMutation, { operation: 'save_draft' }> =
      {
        operation: 'save_draft',
        workspaceId,
        setId: randomUUID(),
        requestId: randomUUID(),
        expectedRevision: 0,
        changeSummary: marker,
        ownership:
          scope === 'company'
            ? { scope, organizationId: company.organizationId }
            : scope === 'personal'
              ? {
                  scope,
                  organizationId: company.organizationId,
                  ownerId: owner.actor.id,
                }
              : {
                  scope: 'department',
                  organizationId: company.organizationId,
                  departmentId: scope.departmentId,
                },
        target:
          scope === 'personal'
            ? { kind: 'instance', instanceId: custom.id }
            : { kind: 'employee', employeeId },
        manifest: {
          schemaVersion: 1,
          common: [{ sourceKind: 'draft_text', contentId }],
          scenes: [
            { id: randomUUID(), name: marker, appliesWhen: marker, references },
          ],
          declaredConflicts: [],
        },
        textEdits: [
          {
            contentId,
            revisionId,
            expectedRevision: 0,
            kind: 'requirement',
            title: marker,
            body: marker,
          },
        ],
      };
    let receipt = await mutateEmployeeContent(owner, input);
    for (const operation of ['validate', 'activate'] as const) {
      receipt = await mutateEmployeeContent(owner, {
        operation,
        workspaceId,
        setId: input.setId,
        ownership: input.ownership,
        target: input.target,
        requestId: randomUUID(),
        expectedRevision: receipt.revision,
        changeSummary: marker,
        candidateRevisionId: receipt.candidate.id,
        candidateDigest: receipt.candidate.digest,
      });
      if (!receipt.validation?.valid) throw Error('fixture_content_validation');
    }
    return { input, receipt };
  };
  const companyContent = await publish('company', '公司共享场景', [
    sharedFile.ref,
  ]);
  await publish({ departmentId: research.id }, '科研共享场景');
  await publish({ departmentId: finance.id }, '财务共享场景');
  await publish('personal', 'PRIVATE_SCENE_SENTINEL', [privateFile.ref]);
  await mutateEmployeeContent(owner, {
    ...companyContent.input,
    requestId: randomUUID(),
    expectedRevision: companyContent.receipt.revision,
    manifest: {
      schemaVersion: 1,
      common: [],
      scenes: [
        {
          id: randomUUID(),
          name: 'CANDIDATE_SENTINEL',
          appliesWhen: 'CANDIDATE_SENTINEL',
          references: [],
        },
      ],
      declaredConflicts: [],
    },
    textEdits: [],
    changeSummary: 'CANDIDATE_SENTINEL',
  });
  return {
    company,
    workspaceId,
    research,
    finance,
    people,
    contexts,
    owner,
    general,
    custom,
    employeeId,
    sharedFile,
    privateFile,
    publication,
    upload,
    companyContent,
  };
}
