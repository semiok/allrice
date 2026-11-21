import {
  EmployeeMemoryRecordSchema,
  EmployeeSkillCatalogSchema,
  ReferenceInputSelectionResultSchema,
  ReferenceLibraryOptionsSchema,
  ReferencePublicationQueryResultSchema,
  ReferenceRevisionSchema,
} from '@allrice/contracts';
import { WorkbenchDeliverablesActionsCatalogSchema } from '../../../../../apps/web/lib/chatflow/workbench-file-actions';

/** Test data follows the approved rev2 samples. These are synthetic resources,
 * not a second business contract, authenticated owner, or storage receipt. */
export const panelsClock = '2026-11-21T12:00:00.000Z';
export const uid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const panelsViewer = uid(1),
  panelsWorkspace = uid(2),
  panelsEmployee = uid(3);
const now = '2026-11-21T08:30:00.000Z';
const checksum = 'sha256:' + 'a'.repeat(64);
const names = [
  '第四季度销售口径说明.pdf',
  '客户周报模板.docx',
  '销售复盘与行动清单.md',
  '2026年度企业服务重点客户续约与交付情况汇总表（华东区最终确认版本）.xlsx',
  '品牌内容撰写指南.pdf',
];
export const panelStates = [
  'list',
  'empty',
  'loading',
  'denied',
  'longname',
] as const;
export type PanelsState = (typeof panelStates)[number];

export function createSyntheticPanelsData(state: PanelsState = 'list') {
  const references = Array.from({ length: 5 }, (_, i) =>
    ReferenceRevisionSchema.parse({
      sourceId: uid(100 + i),
      revisionId: uid(200 + i),
      revision: 1,
      ownership: { scope: 'company', organizationId: uid(4) },
      fileName: names[i],
      purpose: [
        '核对销售统计口径',
        '起草客户工作周报',
        '整理复盘结论与后续动作',
      ][i % 3],
      checksum,
      sizeBytes: 48200,
      mediaType: 'text/markdown',
      status: 'active',
      processing: 'ready',
      failure: null,
      canMaintain: true,
      canReference: true,
      publication: {
        origin: i % 2 ? 'upload' : 'file',
        publisherId: panelsViewer,
        publisherName: '我',
        audience: {
          scope:
            i % 3 === 0 ? 'company' : i % 3 === 1 ? 'departments' : 'personal',
          departmentIds: i % 3 === 1 ? [uid(6)] : [],
        },
        audienceRevision: 1,
      },
      createdAt: now,
      origin: null,
    }),
  );
  const ordered =
    state === 'empty'
      ? []
      : state === 'longname'
        ? [references[3]!, ...references.slice(0, 3)]
        : references;
  const catalog = ReferencePublicationQueryResultSchema.parse({
    references: ordered,
    matches: [],
    nextCursor: null,
    fullTextCoverage: { ready: ordered.length, unavailable: 0 },
  });
  const options = ReferenceLibraryOptionsSchema.parse({
    workspaceId: panelsWorkspace,
    platformMaintainer: false,
    maintenanceLevel: 'company',
    writable: true,
    departmentId: uid(6),
    departments: [{ id: uid(6), name: '销售部' }],
  });
  const files = WorkbenchDeliverablesActionsCatalogSchema.parse({
    viewerId: panelsViewer,
    files: ordered.map((r) => {
      const i = references.indexOf(r);
      return {
        objectId: uid(300 + i),
        workspaceId: panelsWorkspace,
        fileName: r.fileName,
        mediaType: r.mediaType,
        checksum: r.checksum,
        sizeBytes: r.sizeBytes,
        createdAt: now,
        ownedByMe: true,
        canMaintain: true,
        revision: 1,
        sharing: { scope: 'personal', departmentIds: [], departmentNames: [] },
        category: i % 3 ? 'artifact' : 'upload',
        sessionIds: [uid(7)],
        artifact: null,
        isReference: false,
        reference: null,
        origin: i % 3 ? 'business-deliverable' : 'user-upload',
        sources: [
          {
            sessionId: uid(7),
            sessionTitle: '第四季度销售复盘',
            employeeAssignmentId: panelsEmployee,
            employeeInstanceId: panelsEmployee,
            employeeName: 'Rice',
          },
        ],
        favorite: i === 1,
        canPublishReference: true,
        publication: null,
      };
    }),
    employees: [{ id: panelsEmployee, name: 'Rice' }],
    nextCursor: null,
    quotableFileIds: ordered.map((r) => uid(300 + references.indexOf(r))),
  });
  const memories =
    state === 'empty'
      ? []
      : Array.from({ length: 5 }, (_, i) =>
          EmployeeMemoryRecordSchema.parse({
            id: uid(400 + i),
            summary:
              state === 'longname' && i === 0
                ? '每周销售复盘先给结论和待办，再说明数据口径、异常订单以及重点客户交付风险'
                : [
                    '周报先给结论，再列行动项',
                    '金额统一用人民币万元',
                    '涉及数据时标明统计口径和来源',
                  ][i % 3],
            hasDetails: true,
            details: '涉及数字时，说明统计口径和数据来源。',
            state: i < 2 ? 'pending' : 'active',
            capturedAt: now,
            updatedAt: now,
            revision: 1,
            pairDigest: checksum,
          }),
        );
  const selection = (revisionId: string) => {
    const r = references.find((item) => item.revisionId === revisionId);
    if (!r) throw Error('Unknown synthetic revision');
    return ReferenceInputSelectionResultSchema.parse({
      viewerId: panelsViewer,
      workspaceId: panelsWorkspace,
      selection: {
        sourceId: r.sourceId,
        revisionId: r.revisionId,
        revision: r.revision,
        fileName: r.fileName,
        purpose: r.purpose,
        ownership: r.ownership,
        checksum: r.checksum,
        digest: r.checksum,
      },
    });
  };
  const skills = EmployeeSkillCatalogSchema.parse({
    instanceId: panelsEmployee,
    canInstall: true,
    platformSkills:
      state === 'empty'
        ? []
        : ['spreadsheet', 'slides'].map((name, i) => ({
            kind: 'platform',
            id: name,
            name,
            displayName: ['电子表格', '演示文稿'][i],
            description: '',
            version: null,
            checksum,
            canUninstall: false,
          })),
    personalSkills:
      state === 'empty'
        ? []
        : [
            {
              kind: 'personal',
              name: 'sales-analysis',
              installationId: uid(901),
              versionId: uid(902),
              installationVersion: 1,
              revision: 1,
              displayName:
                state === 'longname'
                  ? '企业年度销售明细统计口径校验与客户续约风险检查'
                  : '销售数据分析',
              description: '读取销售明细，核对统计口径并生成复盘结论。',
              version: '1.0.0',
              source: {
                kind: 'attachment',
                objectId: uid(903),
                fileName: 'sales-analysis.zip',
                originalChecksum: checksum,
                byteLength: 1024,
              },
              canUninstall: true,
              definitionChecksum: checksum,
              binding: {
                id: uid(904),
                instanceId: panelsEmployee,
                workspaceId: panelsWorkspace,
                enabled: true,
                epoch: 1,
                label: '销售数据分析',
              },
            },
          ],
  });
  return {
    references,
    catalog: { ...catalog, viewerId: panelsViewer, options },
    options,
    files,
    memories,
    skills,
    selection,
  };
}
