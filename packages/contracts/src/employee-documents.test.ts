import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  EmployeeDocumentsSchema,
  employeeMemoryIndexMaximumInitialBytes,
  isMemoryIndexDocuments,
  employeeDocumentDigestPlaceholder as digest,
  selectEmployeeDocumentMemories,
  renderEmployeeMemoryDocument,
  selectEmployeeUserFacts,
  renderEmployeeUserDocument,
  renderEmployeePersonaDocument,
  EmployeeRunPersonaSourceSchema,
} from './employee-documents.ts';

describe('bounded employee document views', () => {
  it('keeps the legacy USER/MEMORY shape without synthesizing a persona field', () => {
    const legacy = { user: '# USER.md\nUser', memory: '# MEMORY.md\nMemory' };
    const parsed = EmployeeDocumentsSchema.parse(legacy);
    expect(parsed).toEqual(legacy);
    expect(Object.hasOwn(parsed, 'persona')).toBe(false);
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(legacy));
  });
  it.each([1, 2])(
    'v%s bounds the complete rendered PERSONA independently without truncating any document',
    (version) => {
      const envelope = (name: string) =>
        '# PERSONA.md\n' + JSON.stringify({ identity: { name } });
      const fixedBytes = Buffer.byteLength(envelope(''));
      const persona = envelope('a'.repeat(16384 - fixedBytes));
      expect(Buffer.byteLength(persona)).toBe(16384);
      const documents = {
        ...(version === 2 ? { schemaVersion: 2 as const } : {}),
        persona,
        user: 'u'.repeat(2048),
        memory: 'm'.repeat(
          version === 2 ? employeeMemoryIndexMaximumInitialBytes : 6000,
        ),
      };
      expect(EmployeeDocumentsSchema.parse(documents)).toEqual(documents);
      expect(
        EmployeeDocumentsSchema.safeParse({
          ...documents,
          persona: persona + 'a',
        }).success,
      ).toBe(false);
      expect(
        EmployeeDocumentsSchema.safeParse({
          ...documents,
          user: documents.user + 'u',
        }).success,
      ).toBe(false);
      expect(
        EmployeeDocumentsSchema.safeParse({
          ...documents,
          memory: documents.memory + 'm',
        }).success,
      ).toBe(false);
    },
  );
  it.each([1, 2])(
    'v%s counts UTF-8 and JSON escapes in the rendered PERSONA, including its heading and envelope',
    (version) => {
      const render = (name: string) =>
        '# PERSONA.md\n' + JSON.stringify({ identity: { name } });
      const name = '人'.repeat(5400);
      const persona = render(name);
      expect(Buffer.byteLength(persona)).toBeLessThan(16384);
      expect(
        EmployeeDocumentsSchema.parse({
          ...(version === 2 ? { schemaVersion: 2 as const } : {}),
          persona,
          user: '',
          memory: '',
        }).persona,
      ).toBe(persona);
      const escaped = render('\u0000'.repeat(2731));
      expect(Buffer.byteLength('\u0000'.repeat(2731))).toBeLessThan(16384);
      expect(Buffer.byteLength(escaped)).toBeGreaterThan(16384);
      expect(
        EmployeeDocumentsSchema.safeParse({
          ...(version === 2 ? { schemaVersion: 2 as const } : {}),
          persona: escaped,
          user: '',
          memory: '',
        }).success,
      ).toBe(false);
      expect(
        EmployeeDocumentsSchema.safeParse({
          ...(version === 2 ? { schemaVersion: 2 as const } : {}),
          persona: render('人'.repeat(5500)),
          user: '',
          memory: '',
        }).success,
      ).toBe(false);
    },
  );
  it.each([1, 2])(
    'v%s retains absent/empty/literal persona without relaxing strict version or permission fields',
    (version) => {
      const documents = {
        ...(version === 2 ? { schemaVersion: 2 as const } : {}),
        user: '',
        memory: '',
      };
      expect(EmployeeDocumentsSchema.parse(documents)).toEqual(documents);
      expect(
        Object.hasOwn(EmployeeDocumentsSchema.parse(documents), 'persona'),
      ).toBe(false);
      for (const persona of ['', '# PERSONA.md\n{{missing}}']) {
        expect(
          EmployeeDocumentsSchema.parse({ ...documents, persona }),
        ).toEqual({ ...documents, persona });
        expect(
          EmployeeDocumentsSchema.safeParse({
            ...documents,
            persona,
            memoryAuthorized: true,
          }).success,
        ).toBe(false);
        for (const schemaVersion of [0, 1, 3, '2'])
          expect(
            EmployeeDocumentsSchema.safeParse({
              ...documents,
              persona,
              schemaVersion,
            }).success,
          ).toBe(false);
      }
    },
  );
  it('keeps complete conditions, includes envelopes and handles in UTF-8 limits and counts omissions', () => {
    const items = Array.from({ length: 25 }, (_, i) => ({
      id: randomUUID(),
      revision: 1,
      content:
        i === 0
          ? '超长'.repeat(3000)
          : `第${i}条：仅已确认的12笔；不得合并退款。`,
      sourceHandle: `experience:${digest}`,
    }));
    const selected = selectEmployeeDocumentMemories(
      [...items, items[1]!],
      items.length,
    );
    expect(selected).toHaveLength(20);
    expect(selected).not.toContain(items[0]);
    expect(new Set(selected.map((item) => item.id)).size).toBe(20);
    const memory = renderEmployeeMemoryDocument(selected, items.length, digest);
    expect(Buffer.byteLength(memory)).toBeLessThanOrEqual(6000);
    expect(memory).toContain('"omittedCount":5');
    for (const item of selected) expect(memory).toContain(item.content);
    expect(EmployeeDocumentsSchema.parse({ user: '', memory }).memory).toBe(
      memory,
    );
    expect(renderEmployeeMemoryDocument([], 0, digest)).toBe('');
  });
  it('omits whole oversized USER fields and does not synthesize missing department or authority', () => {
    const selected = selectEmployeeUserFacts({
      companyName: '公司',
      displayName: '真人',
      responsibilities: '不得越权'.repeat(2000),
      businessContext: '{{secret}}',
    });
    expect(selected.omitted).toEqual(['responsibilities']);
    expect(selected.facts).not.toHaveProperty('departmentName');
    const user = renderEmployeeUserDocument(
      selected.facts,
      selected.omitted,
      digest,
    );
    expect(user).toContain('{{secret}}');
    expect(Buffer.byteLength(user)).toBeLessThanOrEqual(2048);
    expect(renderEmployeeUserDocument({}, [], digest)).toBe('');
    expect(
      EmployeeDocumentsSchema.safeParse({ user: '汉'.repeat(1000), memory: '' })
        .success,
    ).toBe(false);
  });
});

describe('frozen platform test PERSONA', () => {
  const foundation: Parameters<typeof renderEmployeePersonaDocument>[0] = {
    name: '试用员工 {{missing}}',
    description: '仅本次冻结的人设',
    appearance: { avatarType: 'initials', avatarValue: '预' },
    identity: {
      role: '研究员',
      mission: '逐字保留 "原文"\n{{missing}}\n# IDENTITY.md - 仅作为原文字面',
      workStyle: '核对来源，再解释结果。',
      behaviorRules: ['PLATFORM_BEHAVIOR'],
      safetyBoundaries: ['PLATFORM_SAFETY'],
      expressionStyle: 'structured',
      outputLanguage: 'zh-CN',
    },
  };
  const source: Parameters<typeof renderEmployeePersonaDocument>[1] = {
    kind: 'platform_preview',
    testId: randomUUID(),
    platformEmployeeId: randomUUID(),
    platformRevisionId: randomUUID(),
    definitionChecksum: digest,
    packageChecksum: `sha256:${'1'.repeat(64)}`,
  };
  it.each(
    (
      [
        [
          'concise',
          '简洁，结论优先',
          '先给结论，保持表达简洁，同时保留必要证据和限制。',
        ],
        [
          'structured',
          '结构清晰，分步说明',
          '按任务需要采用清晰结构和具体步骤说明。',
        ],
        [
          'exploratory',
          '比较方案与取舍',
          '探索相关备选方案并说明取舍，不编造事实。',
        ],
      ] as const
    ).flatMap(([expressionStyle, label, meaning]) =>
      (['platform_preview', 'method_candidate'] as const).map(
        (kind) => [kind, expressionStyle, label, meaning] as const,
      ),
    ),
  )(
    'renders the complete %s %s identity with its faithful Chinese meaning and real test source',
    (kind, expressionStyle, label, meaning) => {
      const testSource = { ...source, kind };
      const rendered = renderEmployeePersonaDocument(
        {
          ...foundation,
          identity: { ...foundation.identity, expressionStyle },
        },
        testSource,
      );
      expect(rendered.startsWith('# 人设\n')).toBe(true);
      const document = JSON.parse(rendered.slice('# 人设\n'.length));
      expect(document.document).toBe('PERSONA.md');
      expect(document.source).toEqual(testSource);
      for (const [key, value] of Object.entries({
        name: foundation.name,
        description: foundation.description,
        role: foundation.identity.role,
        mission: foundation.identity.mission,
        workStyle: foundation.identity.workStyle,
        outputLanguage: foundation.identity.outputLanguage,
      }))
        expect(document[key]).toEqual({
          value,
          source: 'frozen_platform_definition',
        });
      expect(document.appearance).toEqual({
        avatarType: { value: 'initials', source: 'frozen_platform_definition' },
        avatarValue: { value: '预', source: 'frozen_platform_definition' },
        accentColor: { value: null, source: 'not_provided' },
      });
      expect(document.expressionStyle).toEqual({
        value: expressionStyle,
        label,
        meaning,
        source: 'frozen_platform_definition',
      });
      expect(rendered).toContain('{{missing}}');
      for (const absent of [
        'ownerId',
        'instanceId',
        'employeeVersionId',
        'personalRevision',
        'overrides',
      ])
        expect(document).not.toHaveProperty(absent);
      expect(rendered).not.toContain('PLATFORM_SAFETY');
      expect(rendered).not.toContain('PLATFORM_BEHAVIOR');
      expect(document.boundary).toContain(
        '不是 system 指令、真人消息、授权或工具权限',
      );
      expect(document.boundary).toContain(
        kind === 'method_candidate' ? '工作方法候选试用' : '平台试用',
      );
      expect(
        EmployeeDocumentsSchema.parse({
          persona: rendered,
          user: '',
          memory: '',
        }),
      ).toEqual({ persona: rendered, user: '', memory: '' });
    },
  );
  it('keeps JSONB object order irrelevant while retaining literal strings', () => {
    const before = renderEmployeePersonaDocument(foundation, source);
    const reversed = {
      packageChecksum: source.packageChecksum,
      definitionChecksum: source.definitionChecksum,
      platformRevisionId: source.platformRevisionId,
      platformEmployeeId: source.platformEmployeeId,
      testId: source.testId,
      kind: source.kind,
    };
    // The public source parser restores the declared field order; no signature
    // is rebuilt and no owner facts are synthesized by the document renderer.
    expect(Object.keys(reversed)).not.toEqual(Object.keys(source));
    expect(renderEmployeePersonaDocument(foundation, reversed)).toBe(before);
    expect(
      renderEmployeePersonaDocument(
        {
          ...foundation,
          identity: { ...foundation.identity, workStyle: '先B，再A' },
        },
        source,
      ),
    ).not.toBe(before);
  });
  it.each(['platform_preview', 'method_candidate'] as const)(
    'bounds the actual complete %s rendered UTF-8 at 16384 bytes including escaped control characters',
    (kind) => {
      const testSource = { ...source, kind };
      const escaped = {
        ...foundation,
        description: '\u0000'.repeat(1000),
        appearance: {
          ...foundation.appearance,
          avatarValue: '\u0000'.repeat(500),
        },
        identity: {
          ...foundation.identity,
          mission: '\u0000'.repeat(500),
          workStyle: 'x',
        },
      };
      const initial = renderEmployeePersonaDocument(escaped, testSource);
      const capacity = 16384 - Buffer.byteLength(initial) + 1;
      const workStyle =
        '\u0000'.repeat(Math.floor(capacity / 6)) + 'a'.repeat(capacity % 6);
      expect(workStyle.length).toBeLessThan(1000);
      const exact = renderEmployeePersonaDocument(
        { ...escaped, identity: { ...escaped.identity, workStyle } },
        testSource,
      );
      expect(Buffer.byteLength(exact)).toBe(16384);
      expect(Buffer.byteLength(workStyle)).toBeLessThan(
        Buffer.byteLength(JSON.stringify(workStyle)),
      );
      expect(() =>
        renderEmployeePersonaDocument(
          {
            ...escaped,
            identity: { ...escaped.identity, workStyle: workStyle + 'a' },
          },
          testSource,
        ),
      ).toThrow();
      expect(
        EmployeeDocumentsSchema.parse({
          persona: exact,
          user: 'u'.repeat(2048),
          memory: 'm'.repeat(6000),
        }),
      ).toEqual({
        persona: exact,
        user: 'u'.repeat(2048),
        memory: 'm'.repeat(6000),
      });
    },
  );
});

describe('normal Run PERSONA defaults and sparse personal sources', () => {
  const foundation: Parameters<typeof renderEmployeePersonaDocument>[0] = {
    name: '当前平台名字',
    description: '当前平台介绍',
    appearance: {
      avatarType: 'emoji',
      avatarValue: '🍚',
      accentColor: 'green',
    },
    identity: {
      role: '平台角色',
      mission: '平台职责',
      workStyle: '平台方式',
      behaviorRules: ['HARD_RULE'],
      safetyBoundaries: ['HARD_SAFETY'],
      expressionStyle: 'structured',
      outputLanguage: 'zh-CN',
    },
  };
  const version = () => ({
    employeeVersionId: randomUUID(),
    configChecksum: digest,
    manifestDigest: digest,
    templateId: randomUUID(),
    templateRevisionId: randomUUID(),
    templateRevision: 1,
    templateChecksum: digest,
    packageChecksum: digest,
  });
  const source = (
    profileEligibility: 'full_identity' | 'expression_only' = 'full_identity',
  ) =>
    EmployeeRunPersonaSourceSchema.parse({
      kind: 'employee_run',
      organizationId: randomUUID(),
      workspaceId: randomUUID(),
      employeeId: randomUUID(),
      assignmentId: randomUUID(),
      instanceId: randomUUID(),
      ownerId: randomUUID(),
      profileRevision: 2,
      profileEligibility,
      basis: version(),
      engine: version(),
    });
  const read = (text: string) => JSON.parse(text.slice('# 人设\n'.length));
  it('keeps real tenant evidence distinct from publication and preserves sparse overrides', () => {
    const tenant = {
      kind: 'tenant_version' as const,
      employeeVersionId: randomUUID(),
      configChecksum: digest,
      manifestDigest: digest,
    };
    const frozen = EmployeeRunPersonaSourceSchema.parse({
      ...source(),
      basis: tenant,
      engine: tenant,
    });
    const document = read(
      renderEmployeePersonaDocument(foundation, frozen, {
        mission: 'Tenant literal {{missing}}',
      }),
    );
    expect(document.source.basis).toEqual(tenant);
    expect(document.source.engine).toEqual(tenant);
    expect(document.name.source).toBe('tenant_default');
    expect(document.mission).toEqual({
      value: 'Tenant literal {{missing}}',
      source: 'personal_override',
    });
    expect(document.boundary).toContain('当前租户员工默认');
    for (const field of [
      'packageChecksum',
      'templateId',
      'templateRevisionId',
    ]) {
      expect(
        EmployeeRunPersonaSourceSchema.safeParse({
          ...frozen,
          engine: {
            ...tenant,
            [field]: field === 'packageChecksum' ? digest : randomUUID(),
          },
        }).success,
      ).toBe(false);
    }
    const { kind: _kind, ...missingKind } = tenant;
    void _kind;
    expect(
      EmployeeRunPersonaSourceSchema.safeParse({
        ...frozen,
        basis: missingKind,
      }).success,
    ).toBe(false);
  });
  it.each([
    'native_once',
    'native_recurring',
    'folder_event',
    'automation_manual',
  ] as const)(
    'renders the actual frozen %s engine without changing ordinary default provenance',
    (kind) => {
      const ordinary = source();
      const task = {
        kind,
        id: randomUUID(),
        sessionId: randomUUID(),
        userMessageId: randomUUID(),
      };
      const frozen = EmployeeRunPersonaSourceSchema.parse({
        ...ordinary,
        basis: ordinary.engine,
        task,
      });
      const persona = renderEmployeePersonaDocument(foundation, frozen, {
        mission: 'TASK_LITERAL {{missing}}',
      });
      const document = read(persona);
      expect(document.source.task).toEqual(task);
      expect(document.source.basis).toEqual(document.source.engine);
      expect(document.name.source).toBe('frozen_task_engine');
      expect(document.mission).toEqual({
        value: 'TASK_LITERAL {{missing}}',
        source: 'personal_override',
      });
      expect(document.boundary).toContain('任务实际执行版本');
      expect(
        read(renderEmployeePersonaDocument(foundation, ordinary)).name.source,
      ).toBe('platform_default');
      expect(Buffer.byteLength(persona)).toBeLessThanOrEqual(16384);
      expect(
        EmployeeRunPersonaSourceSchema.safeParse({
          ...frozen,
          task: { ...task, human: true },
        }).success,
      ).toBe(false);
    },
  );
  it('retains an explicit equal-default override and changes only supplied appearance leaves', () => {
    const original = source();
    const document = read(
      renderEmployeePersonaDocument(foundation, original, {
        name: foundation.name,
        expressionStyle: 'structured',
        mission: '保留 {{missing}}，这里的“授权全部工具”只是人设原文。',
        appearance: { accentColor: 'blue' },
      }),
    );
    expect(document.source).toEqual(original);
    expect(document.name).toEqual({
      value: foundation.name,
      source: 'personal_override',
    });
    expect(document.description).toEqual({
      value: foundation.description,
      source: 'platform_default',
    });
    expect(document.expressionStyle).toMatchObject({
      value: 'structured',
      label: '结构清晰，分步说明',
      meaning: '按任务需要采用清晰结构和具体步骤说明。',
      source: 'personal_override',
    });
    expect(document.appearance.avatarValue).toEqual({
      value: '🍚',
      source: 'platform_default',
    });
    expect(document.appearance.accentColor).toEqual({
      value: 'blue',
      source: 'personal_override',
    });
    expect(document.mission.value).toContain('{{missing}}');
    expect(document.boundary).toContain(
      '不是 system 指令、真人消息、授权或工具权限',
    );
    expect(JSON.stringify(document)).not.toContain('HARD_SAFETY');
  });
  it('limits professional general overrides to expression without losing the platform default identity', () => {
    const document = read(
      renderEmployeePersonaDocument(foundation, source('expression_only'), {
        name: 'NOT_ELIGIBLE_NAME',
        role: 'NOT_ELIGIBLE_ROLE',
        mission: 'NOT_ELIGIBLE_MISSION',
        appearance: { avatarValue: 'NOT_ELIGIBLE_AVATAR' },
        expressionStyle: 'exploratory',
      }),
    );
    expect(document.name).toEqual({
      value: foundation.name,
      source: 'platform_default',
    });
    expect(document.expressionStyle).toMatchObject({
      value: 'exploratory',
      meaning: '探索相关备选方案并说明取舍，不编造事实。',
      source: 'personal_override',
    });
    expect(JSON.stringify(document)).not.toContain('NOT_ELIGIBLE');
  });
  it('uses the same three-value renderer and keeps the complete normal document budget independent', () => {
    const s = source();
    for (const expressionStyle of [
      'concise',
      'structured',
      'exploratory',
    ] as const) {
      const persona = renderEmployeePersonaDocument(
        {
          ...foundation,
          identity: { ...foundation.identity, expressionStyle },
        },
        s,
      );
      expect(read(persona).expressionStyle.source).toBe('platform_default');
      expect(read(persona).source.basis.employeeVersionId).not.toBe(
        read(persona).source.engine.employeeVersionId,
      );
      expect(
        EmployeeDocumentsSchema.parse({
          persona,
          user: 'u'.repeat(2048),
          memory: 'm'.repeat(6000),
        }).persona,
      ).toBe(persona);
    }
    expect(() =>
      renderEmployeePersonaDocument(
        {
          ...foundation,
          description: '\u0000'.repeat(1000),
          appearance: {
            avatarType: 'initials',
            avatarValue: '\u0000'.repeat(500),
          },
          identity: {
            ...foundation.identity,
            mission: '\u0000'.repeat(500),
            workStyle: '\u0000'.repeat(1000),
          },
        },
        s,
      ),
    ).toThrow();
  });
});

it('shares only the strict documents version contract while leaving the old 6000-byte shape intact', () => {
  const legacy = { user: '', memory: 'x'.repeat(6000) };
  expect(EmployeeDocumentsSchema.parse(legacy)).toEqual(legacy);
  expect(isMemoryIndexDocuments(legacy)).toBe(false);
  expect(
    EmployeeDocumentsSchema.safeParse({
      ...legacy,
      memory: legacy.memory + 'x',
    }).success,
  ).toBe(false);
  const current = {
    schemaVersion: 2 as const,
    user: '',
    memory: 'x'.repeat(employeeMemoryIndexMaximumInitialBytes),
  };
  expect(EmployeeDocumentsSchema.parse(current)).toEqual(current);
  expect(isMemoryIndexDocuments(current)).toBe(true);
  expect(
    EmployeeDocumentsSchema.safeParse({
      ...current,
      memory: current.memory + 'x',
    }).success,
  ).toBe(false);
  expect(
    EmployeeDocumentsSchema.safeParse({ ...current, writeVersion: 2 }).success,
  ).toBe(false);
});
