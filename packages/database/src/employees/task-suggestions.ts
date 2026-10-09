import {
  allRiceToolManifest,
  TaskSuggestionDisplaySchema,
  TaskSuggestionsSchema,
  type EmployeeManifest,
  type PlatformEmployeeDefinition,
  type TaskSuggestion,
  type TaskSuggestionDisplay,
} from '@allrice/contracts';

import { financeTaskSuggestions } from './finance-task-suggestions.js';

const toolCapabilities = new Map(
  allRiceToolManifest.map((tool) => [
    tool.canonicalName as string,
    tool.capability,
  ]),
);

/** Exact admin paths; a task reference cannot add a tool or Skill to an employee. */
export function taskSuggestionConfigurationErrors(
  definition: Pick<
    PlatformEmployeeDefinition,
    'taskSuggestions' | 'capabilities' | 'securityPolicy'
  >,
) {
  const errors: string[] = [];
  for (const [index, suggestion] of (
    definition.taskSuggestions ?? []
  ).entries()) {
    const path = `基础 → 推荐任务 ${index + 1}（${suggestion.id}）`;
    for (const tool of suggestion.requires?.toolNames ?? []) {
      if (!toolCapabilities.has(tool))
        errors.push(`${path} → 工具引用不存在：${tool}`);
      else if (!definition.capabilities.toolNames.includes(tool))
        errors.push(`${path} → 员工未装配工具：${tool}`);
      else if (
        definition.securityPolicy.deniedCapabilities.includes(
          toolCapabilities.get(tool)!,
        )
      )
        errors.push(`${path} → 工具能力被员工策略拒绝：${tool}`);
    }
    for (const id of suggestion.requires?.nativeSkillIds ?? [])
      if (!definition.capabilities.nativeSkillIds.includes(id))
        errors.push(`${path} → 员工未装配 Skill：${id}`);
    for (const capability of suggestion.requires?.capabilities ?? [])
      if (definition.securityPolicy.deniedCapabilities.includes(capability))
        errors.push(`${path} → 员工策略拒绝能力：${capability}`);
  }
  return errors;
}

function baseDefaults(): TaskSuggestion[] {
  return [
    {
      id: 'organize-materials',
      title: '整理资料',
      description: '提炼重点、待办与需要确认的问题。',
      template: '整理我添加的资料，提炼重点、待办和需要确认的问题。',
      requires: { toolNames: ['workspace.document.read'] },
      preparation: ['files'],
    },
    {
      id: 'make-plan',
      title: '制定计划',
      template:
        '为{{目标}}制定一个{{周期}}的执行计划，列出步骤、负责人和完成标准。',
      slots: [
        { name: '目标', label: '目标', required: true },
        {
          name: '周期',
          label: '周期',
          defaultValue: '一周',
          options: ['一周', '一个月', '一个季度'],
        },
      ],
    },
    {
      id: 'write-summary',
      title: '撰写总结',
      template: '根据我提供的内容，写一份{{用途}}，先给结论，再列关键依据。',
      slots: [{ name: '用途', label: '用途', defaultValue: '工作总结' }],
      preparation: ['files'],
    },
    {
      id: 'organize-expenses',
      title: '整理报销材料',
      description: '财务：梳理费用、凭证缺项和待核对事项。',
      template:
        '整理我添加的报销材料，列出费用明细、缺失凭证和需要人工核对的事项。',
      requires: { toolNames: ['workspace.document.read'] },
      preparation: ['files'],
    },
    {
      id: 'draft-notice',
      title: '起草通知公文',
      description: '运营：根据已有信息起草可编辑文字。',
      template:
        '根据我提供的信息，起草一份{{用途}}，明确对象、时间、事项和下一步。',
      slots: [{ name: '用途', label: '公文用途', defaultValue: '工作通知' }],
    },
    {
      id: 'review-project',
      title: '梳理项目代码',
      description: '程序员：只读检查结构与待确认问题。',
      template:
        '只读检查已选项目目录，梳理代码结构、主要入口和需要确认的问题，先不要修改文件或运行命令。',
      requires: {
        toolNames: ['local.fs.list', 'local.fs.read'],
        readiness: ['local_files'],
      },
      preparation: ['bridge'],
    },
    {
      id: 'review-literature',
      title: '梳理研究文献',
      description: '科研：比较研究问题、方法与证据。',
      template:
        '梳理我添加的研究文献，比较研究问题、方法、证据与局限，并保留可核对的来源。',
      requires: { toolNames: ['workspace.document.read'] },
      preparation: ['files'],
    },
    {
      id: 'research-plan',
      title: '制定研究方案',
      description: '科研：明确假设、方法和验证标准。',
      template:
        '围绕{{研究问题}}制定研究方案，列出假设、方法、数据需求、验证标准与局限。',
      slots: [{ name: '研究问题', label: '研究问题', required: true }],
    },
  ];
}

function legacyDefaults(
  manifest: Extract<EmployeeManifest, { schemaVersion: 2 }>,
): TaskSuggestion[] {
  const base = baseDefaults();
  const financeTasks = financeTaskSuggestions(manifest);
  const project = manifest.runtimePackage?.skills.find(
    (skill) =>
      skill.name === 'project-development' &&
      ['workspace.project', 'workspace.skill.read'].every((tool) =>
        skill.requiredToolRefs.includes(tool),
      ),
  );
  const canExecuteProject = [
    'local.process.execute',
    'cloud.process.execute',
  ].some((tool) => manifest.capabilityBindings.toolNames.includes(tool));
  const projectTasks: TaskSuggestion[] =
    project && canExecuteProject
      ? [
          {
            id: 'develop-project',
            title: '开发实用小工具',
            description: '程序员：从需求到测试、预览与可下载源码。',
            template:
              '为我开发一个{{用途}}。先明确输入、输出和验收标准，完成最小可用功能并实际测试；交付可下载源码、构建成果、运行说明和私有预览。已有资料请先读取，未完成项如实说明。',
            slots: [{ name: '用途', label: '小工具用途', required: true }],
            requires: {
              toolNames: ['workspace.project', 'workspace.skill.read'],
              nativeSkillIds: [project.id],
            },
          },
          {
            id: 'iterate-project',
            title: '继续修改已交付项目',
            description: '程序员：保留原版本和测试，交付验证后的新版本。',
            template:
              '继续本会话中已交付的项目，实现{{改动}}。先确认原项目与版本，保留原验收断言，验证原功能和新增行为；交付新版本源码、测试结果、构建成果和对应预览，并保留上一版交付。',
            slots: [{ name: '改动', label: '本次改动', required: true }],
            requires: {
              toolNames: ['workspace.project', 'workspace.skill.read'],
              nativeSkillIds: [project.id],
            },
          },
        ]
      : [];
  const office = manifest.runtimePackage?.skills.find(
    (skill) =>
      skill.name === 'office' &&
      [
        'workspace.skill.read',
        'workspace.document.read',
        'workspace.export.create',
      ].every((tool) => skill.requiredToolRefs.includes(tool)),
  );
  if (!office) return [...projectTasks, ...financeTasks, ...base].slice(0, 8);
  const scientific = manifest.runtimePackage?.skills.find(
    (skill) =>
      skill.name === 'scientific-analysis' &&
      [
        'workspace.document.read',
        'workspace.skill.read',
        'python.execute',
        'workspace.export.create',
      ].every((tool) => skill.requiredToolRefs.includes(tool)),
  );
  const scientificTasks: TaskSuggestion[] = scientific
    ? [
        {
          id: 'analyze-research-data',
          title: '分析研究数据',
          description: '科研：核对来源、计算与限制，交付可复算研究成果。',
          template:
            '围绕{{研究问题}}分析我添加的资料和数据。先核对来源、样本、单位与缺失处理，实际计算并验证结果，区分描述、关联与因果；交付研究报告、图表、结构化结果及可复算脚本，引用可核查，未完成项如实说明。',
          slots: [{ name: '研究问题', label: '研究问题', required: true }],
          requires: {
            nativeSkillIds: [scientific.id, office.id],
            toolNames: [
              'workspace.document.read',
              'workspace.skill.read',
              'python.execute',
              'workspace.export.create',
            ],
            readiness: ['report'],
          },
          preparation: ['files'],
        },
        {
          id: 'iterate-research-analysis',
          title: '继续研究分析',
          description: '科研：复用原始资料，验证变化并保留报告版本。',
          template:
            '继续本会话中已交付的研究，实现{{改动}}。先读取原始输入、上一版报告与计算脚本，只做本次变更，验证保留的结果和新增分析；交付可复算结果与报告新版本，说明改动并保留上一版成果。',
          slots: [{ name: '改动', label: '本次研究改动', required: true }],
          requires: {
            nativeSkillIds: [scientific.id, office.id],
            toolNames: [
              'workspace.document.read',
              'workspace.skill.read',
              'python.execute',
              'workspace.export.create',
            ],
            readiness: ['report'],
          },
        },
      ]
    : [];
  // Format support comes from the actual frozen Office Skill plus its Broker tool.
  const requires = {
    nativeSkillIds: [office.id],
    toolNames: [
      'workspace.skill.read',
      'workspace.document.read',
      'workspace.export.create',
    ],
    readiness: ['report' as const],
  };
  const officeTasks: TaskSuggestion[] = [
    ...projectTasks,
    ...scientificTasks,
    ...financeTasks,
    {
      id: 'office-word-report',
      title: '制作 Word 报告',
      description: '运营：根据资料交付可下载的 Word 文件。',
      template: '根据我添加的资料制作{{主题}}报告，交付可下载的 Word 文件。',
      slots: [{ name: '主题', label: '报告主题', defaultValue: '工作' }],
      requires,
      preparation: ['files'],
    },
    {
      id: 'office-excel-table',
      title: '整理 Excel 表格',
      description: '财务：保留必要公式并说明异常项。',
      template: '整理我添加的数据，生成 Excel 表格，保留必要公式并说明异常项。',
      requires,
      preparation: ['files'],
    },
    {
      id: 'office-ppt-report',
      title: '制作 PPT 汇报',
      description: '运营：根据资料交付可编辑的 PPT。',
      template: '根据我添加的资料制作{{页数}}页{{用途}}PPT，交付可编辑文件。',
      slots: [
        {
          name: '页数',
          label: '页数',
          defaultValue: '6',
          options: ['6', '10', '15'],
        },
        { name: '用途', label: '汇报用途', defaultValue: '工作汇报' },
      ],
      requires,
      preparation: ['files'],
    },
    {
      id: 'office-word-notice',
      title: '制作 Word 公文',
      description: '运营：通知、纪要和制度流程。',
      template:
        '根据我添加的资料，制作一份{{用途}}，交付可编辑的 Word 文件；缺少的信息明确标注。',
      slots: [
        {
          name: '用途',
          label: '公文类型',
          defaultValue: '工作通知',
          options: ['工作通知', '会议纪要', '制度流程'],
        },
      ],
      requires,
      preparation: ['files'],
    },
    {
      id: 'office-research-report',
      title: '整理研究报告',
      description: '科研：归纳方法、证据与局限。',
      template:
        '根据我添加的文献或研究记录，整理研究问题、方法、证据与局限，保留来源，交付 Word 研究报告。',
      requires,
      preparation: ['files'],
    },
    ...base.filter((suggestion) =>
      ['review-project', 'make-plan', 'research-plan'].includes(suggestion.id),
    ),
  ];
  return officeTasks.slice(0, 8);
}

/** Read-time display projection only. It never changes a frozen definition/checksum. */
export function projectEmployeeTaskSuggestions(
  manifest: EmployeeManifest,
): TaskSuggestionDisplay[] {
  const definition = manifest.schemaVersion === 2 ? manifest : null;
  if (
    manifest.provider.provider === 'basic' ||
    !manifest.capabilities.includes('model:invoke') ||
    definition?.securityPolicy.deniedCapabilities.includes('model:invoke')
  )
    return [];
  const tools = new Set(definition?.capabilityBindings.toolNames ?? []);
  const skills = new Set(
    definition?.runtimePackage?.skills.map((skill) => skill.id) ?? [],
  );
  const declared = new Set(manifest.capabilities);
  const denied = new Set(definition?.securityPolicy.deniedCapabilities ?? []);
  const configured = definition
    ? (definition.taskSuggestions ?? legacyDefaults(definition))
    : baseDefaults()
        .filter((task) => !task.requires)
        .map((task) => ({ ...task, preparation: undefined }));
  return TaskSuggestionsSchema.parse(configured)
    .filter(
      (suggestion) =>
        (suggestion.requires?.toolNames ?? []).every((tool) => {
          const capability = toolCapabilities.get(tool);
          return (
            capability &&
            tools.has(tool) &&
            declared.has(capability) &&
            !denied.has(capability)
          );
        }) &&
        (suggestion.requires?.nativeSkillIds ?? []).every((id) =>
          skills.has(id),
        ) &&
        (suggestion.requires?.capabilities ?? []).every(
          (capability) => declared.has(capability) && !denied.has(capability),
        ),
    )
    .map(({ requires, ...display }) =>
      TaskSuggestionDisplaySchema.parse({
        ...display,
        ...(requires?.readiness?.length
          ? { readiness: requires.readiness }
          : {}),
      }),
    );
}
