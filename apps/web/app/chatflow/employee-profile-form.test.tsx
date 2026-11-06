import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  EmployeeInstanceProfileSchema,
  employeeColorPalette,
} from '@allrice/contracts';
import { employeeDetailsFixture } from '../../test/employee-details-fixture';
import {
  EmployeeProfileForm,
  canEditEmployeePersona,
  canResetEmployeePersona,
  defaultEmployeeProfileFormValues,
  employeeProfileFormFromRaw,
  mergeEmployeeProfileForm,
  type EmployeeProfileFormValues,
} from './employee-profile-form';

describe('shared employee profile form', () => {
  const editing = (...fields: Array<keyof EmployeeProfileFormValues>) =>
    new Set(fields);

  it('requires an explicit owner Rice capability for the optional reset entry', () => {
    const profile = employeeDetailsFixture().profile;
    profile.isDefaultRice = true;
    profile.editableFields = EmployeeInstanceProfileSchema.keyof().options;
    expect(canResetEmployeePersona(profile)).toBe(true);
    for (const isDefaultRice of [undefined, false]) {
      profile.isDefaultRice = isDefaultRice;
      expect(canResetEmployeePersona(profile)).toBe(false);
    }
    profile.isDefaultRice = true;
    profile.canMaintainPersonal = false;
    expect(canResetEmployeePersona(profile)).toBe(false);
    profile.canMaintainPersonal = true;
    profile.editableFields = ['expressionStyle'];
    expect(canResetEmployeePersona(profile)).toBe(false);
  });

  it('leaves default callers unchanged and limits the reset slot to an unlocked Rice editor', () => {
    const profile = employeeDetailsFixture().profile;
    profile.isDefaultRice = true;
    profile.editableFields = EmployeeInstanceProfileSchema.keyof().options;
    for (const mode of ['create', 'edit'] as const) {
      for (const offer of [false, true]) {
        for (const busy of [false, true]) {
          const html = renderToStaticMarkup(
            <EmployeeProfileForm
              mode={mode}
              initialValue={defaultEmployeeProfileFormValues}
              busy={busy}
              reset={offer ? { profile, onRequest: () => {} } : undefined}
              onSubmit={() => {}}
              onCancel={() => {}}
            />,
          );
          if (mode === 'edit' && offer) {
            expect(html).toContain('恢复默认</button>');
            expect(html).toMatch(
              busy
                ? /<button[^>]*disabled=""[^>]*>恢复默认<\/button>/
                : /<button(?![^>]*disabled)[^>]*>恢复默认<\/button>/,
            );
          } else expect(html).not.toContain('恢复默认');
        }
      }
    }
    for (const canMaintainPersonal of [false, true]) {
      profile.canMaintainPersonal = canMaintainPersonal;
      profile.isDefaultRice = false;
      expect(
        renderToStaticMarkup(
          <EmployeeProfileForm
            mode="edit"
            initialValue={defaultEmployeeProfileFormValues}
            reset={{ profile, onRequest: () => {} }}
            onSubmit={() => {}}
            onCancel={() => {}}
          />,
        ),
      ).not.toContain('恢复默认');
    }
  });

  it('requires the current complete field capability, independent of kind, name and saved overrides', () => {
    const profile = employeeDetailsFixture().profile;
    profile.editableFields = EmployeeInstanceProfileSchema.keyof().options;
    profile.personalFields = [];
    for (const kind of ['general', 'custom'] as const) {
      profile.kind = kind;
      expect(canEditEmployeePersona(profile)).toBe(true);
    }
    for (const editableFields of [
      undefined,
      [],
      ['expressionStyle'] as const,
      ['name', 'mission', 'workStyle', 'expressionStyle'] as const,
    ]) {
      profile.editableFields = editableFields ? [...editableFields] : undefined;
      expect(canEditEmployeePersona(profile)).toBe(false);
    }
    profile.editableFields = EmployeeInstanceProfileSchema.keyof().options;
    profile.canMaintainPersonal = false;
    expect(canEditEmployeePersona(profile)).toBe(false);
  });

  it('keeps creation fields while applying the approved edit label and ten colors', () => {
    for (const mode of ['create', 'edit'] as const) {
      const html = renderToStaticMarkup(
        <EmployeeProfileForm
          mode={mode}
          initialValue={defaultEmployeeProfileFormValues}
          onSubmit={() => {}}
          onCancel={() => {}}
        />,
      );
      expect(html.match(/type="radio"/g)).toHaveLength(10);
      for (const { label } of Object.values(employeeColorPalette))
        expect(html).toContain(label);
      for (const label of [
        mode === 'create' ? '员工名字' : '名字',
        '头像颜色',
        '使命',
        '工作方式',
        '表达偏好',
      ])
        expect(html).toContain(label);
      if (mode === 'create')
        expect(html).toContain(
          'placeholder="例如： 文案专家、财务专员、商务分析师"',
        );
      else {
        expect(html).not.toContain('员工名字');
        expect(html).not.toContain('placeholder=');
      }
      expect(html).toContain('取消');
      expect(html).toContain(
        mode === 'create' ? '创建</button>' : '保存</button>',
      );
      expect(html).toContain('type="submit" disabled=""');
      expect(html).not.toContain('基础员工');
    }
  });

  it('prefers saved personal values, falls back to the authorized effective profile, and does not mutate either', () => {
    const resolved = employeeDetailsFixture().profile;
    const raw = EmployeeInstanceProfileSchema.parse({
      name: '个人研究助理',
      mission: '我的研究目标',
      appearance: {
        avatarType: 'emoji',
        avatarValue: '🦊',
        accentColor: 'coral',
      },
    });
    expect(employeeProfileFormFromRaw(raw, resolved)).toEqual({
      name: '个人研究助理',
      accentColor: 'coral',
      mission: '我的研究目标',
      workStyle: resolved.identity.workStyle,
      expressionStyle: resolved.expressionStyle,
    });
    expect(raw).not.toHaveProperty('workStyle');
    expect(resolved.name).toBe('Rice');
  });

  it('sends all three new-employee persona values with the chosen name and color to the existing contract', () => {
    expect(
      mergeEmployeeProfileForm(
        {},
        {
          ...defaultEmployeeProfileFormValues,
          name: '  𠮷野财务助手  ',
          accentColor: 'green',
        },
      ),
    ).toEqual({
      name: '𠮷野财务助手',
      mission: defaultEmployeeProfileFormValues.mission,
      workStyle: defaultEmployeeProfileFormValues.workStyle,
      expressionStyle: 'structured',
      appearance: {
        avatarType: 'initials',
        avatarValue: '𠮷',
        accentColor: 'green',
      },
    });
  });

  it('keeps untouched inherited text out of a general rename patch', () => {
    const resolved = employeeDetailsFixture().profile;
    const raw = EmployeeInstanceProfileSchema.parse({
      description: '本人已有简介',
      role: '本人已有角色',
      expressionStyle: 'concise',
    });
    const before = structuredClone(raw);
    const result = mergeEmployeeProfileForm(
      raw,
      { ...employeeProfileFormFromRaw(raw, resolved), name: '青禾' },
      resolved,
      editing('name'),
    );
    expect(result).not.toHaveProperty('mission');
    expect(result).not.toHaveProperty('workStyle');
    expect(result).not.toHaveProperty('appearance');
    expect(result).toEqual({ name: '青禾' });
    expect({ ...raw, ...result }).toEqual({ ...before, name: '青禾' });
    expect(raw).toEqual(before);
  });

  it('retains existing raw custom overrides in a name-only replacement', () => {
    const resolved = employeeDetailsFixture().profile;
    resolved.kind = 'custom';
    const raw = EmployeeInstanceProfileSchema.parse({
      description: '本人已有简介',
      role: '本人已有角色',
      mission: '本人已有使命',
      expressionStyle: 'concise',
      appearance: { avatarType: 'image', avatarValue: '/personal.png' },
    });
    const before = structuredClone(raw);
    const result = mergeEmployeeProfileForm(
      raw,
      { ...employeeProfileFormFromRaw(raw, resolved), name: '青禾' },
      resolved,
      editing('name'),
    );
    expect(result).toEqual({ ...before, name: '青禾' });
    expect(result).not.toHaveProperty('workStyle');
    expect(raw).toEqual(before);
  });

  it('retains explicitly edited text even when its value equals the displayed default', () => {
    const resolved = employeeDetailsFixture().profile;
    const values = employeeProfileFormFromRaw({}, resolved);
    for (const field of ['mission', 'workStyle', 'expressionStyle'] as const) {
      expect(
        mergeEmployeeProfileForm({}, values, resolved, editing(field)),
      ).toEqual({ [field]: values[field] });
    }
  });

  it('leaves existing overrides alone when no field was edited', () => {
    const resolved = employeeDetailsFixture().profile;
    const raw = EmployeeInstanceProfileSchema.parse({
      name: '本人名字',
      mission: '本人使命',
    });
    const values = employeeProfileFormFromRaw(raw, resolved);
    expect(mergeEmployeeProfileForm(raw, values, resolved, editing())).toEqual(
      {},
    );
    resolved.kind = 'custom';
    expect(mergeEmployeeProfileForm(raw, values, resolved, editing())).toEqual(
      raw,
    );
  });

  it('does not create an inherited avatar override and only derives an already personal initials rename', () => {
    const resolved = employeeDetailsFixture().profile;
    resolved.appearance = {
      avatarType: 'image',
      avatarValue: '/inherited.png',
      accentColor: 'coral',
    };
    for (const kind of ['general', 'custom'] as const) {
      resolved.kind = kind;
      expect(
        mergeEmployeeProfileForm(
          {},
          { ...employeeProfileFormFromRaw({}, resolved), name: '青禾' },
          resolved,
          editing('name'),
        ),
      ).toEqual({ name: '青禾' });
    }
    resolved.kind = 'general';
    const raw = EmployeeInstanceProfileSchema.parse({
      appearance: {
        avatarType: 'initials',
        avatarValue: '原',
        accentColor: 'indigo',
      },
    });
    expect(
      mergeEmployeeProfileForm(
        raw,
        { ...employeeProfileFormFromRaw(raw, resolved), name: '𠮷野助手' },
        resolved,
        editing('name'),
      ),
    ).toEqual({
      name: '𠮷野助手',
      appearance: { ...raw.appearance, avatarValue: '𠮷' },
    });
  });

  it('keeps the existing complete avatar contract only when its color is actually edited', () => {
    const resolved = employeeDetailsFixture().profile;
    resolved.appearance = {
      avatarType: 'image',
      avatarValue: '/inherited.png',
      accentColor: 'coral',
    };
    expect(
      mergeEmployeeProfileForm(
        {},
        { ...employeeProfileFormFromRaw({}, resolved), accentColor: 'teal' },
        resolved,
        editing('accentColor'),
      ),
    ).toEqual({
      appearance: { ...resolved.appearance, accentColor: 'teal' },
    });
  });

  it.each(['emoji', 'image'] as const)(
    'retains hidden profile fields and the saved %s avatar when merging an edit',
    (avatarType) => {
      const raw = EmployeeInstanceProfileSchema.parse({
        name: '原员工',
        description: '原简介不能被表单清除',
        role: '原角色不能被表单清除',
        appearance: {
          avatarType,
          avatarValue: avatarType === 'image' ? '/employee-avatar.png' : '🦊',
          accentColor: 'violet',
        },
      });
      const snapshot = structuredClone(raw);
      const result = mergeEmployeeProfileForm(raw, {
        ...defaultEmployeeProfileFormValues,
        name: '新员工',
        accentColor: 'teal',
        mission: '  新使命  ',
        workStyle: '  新工作方式  ',
        expressionStyle: 'concise',
      });
      expect(result).toEqual({
        ...raw,
        name: '新员工',
        mission: '新使命',
        workStyle: '新工作方式',
        expressionStyle: 'concise',
        appearance: { ...raw.appearance, accentColor: 'teal' },
      });
      expect(raw).toEqual(snapshot);
    },
  );

  it.each(['emoji', 'image'] as const)(
    'retains an inherited %s avatar without materializing resolved hidden identity fields',
    (avatarType) => {
      const resolved = employeeDetailsFixture().profile;
      resolved.appearance = {
        avatarType,
        avatarValue: avatarType === 'emoji' ? '🦊' : '/inherited-avatar.png',
        accentColor: 'coral',
      };
      const raw = { description: '私人简介', role: '私人角色' };
      const snapshot = structuredClone(resolved);
      const result = mergeEmployeeProfileForm(
        raw,
        { ...employeeProfileFormFromRaw(raw, resolved), accentColor: 'teal' },
        resolved,
      );
      expect(result).toMatchObject({
        description: raw.description,
        role: raw.role,
        appearance: { ...resolved.appearance, accentColor: 'teal' },
      });
      expect(result).not.toHaveProperty('identity');
      expect(result).not.toHaveProperty('defaults');
      expect(raw).not.toHaveProperty('appearance');
      expect(resolved).toEqual(snapshot);
      const withoutHidden = mergeEmployeeProfileForm(
        {},
        employeeProfileFormFromRaw({}, resolved),
        resolved,
      );
      expect(withoutHidden).not.toHaveProperty('description');
      expect(withoutHidden).not.toHaveProperty('role');
    },
  );

  it('updates initials after a rename while preserving the legacy indigo appearance when unchanged', () => {
    const raw = EmployeeInstanceProfileSchema.parse({
      name: '原员工',
      appearance: {
        avatarType: 'initials',
        avatarValue: '原',
        accentColor: 'indigo',
      },
    });
    const values = employeeProfileFormFromRaw(raw);
    expect(values.accentColor).toBe('blue');
    expect(
      mergeEmployeeProfileForm(raw, { ...values, name: '𠮷野助手' }).appearance,
    ).toEqual({
      avatarType: 'initials',
      avatarValue: '𠮷',
      accentColor: 'indigo',
    });
  });

  it('enforces the persisted field limits instead of silently dropping or truncating values', () => {
    for (const invalid of [
      { name: ' ' },
      { mission: ' ' },
      { mission: '任'.repeat(501) },
      { workStyle: ' ' },
      { workStyle: '方'.repeat(1_001) },
    ])
      expect(() =>
        mergeEmployeeProfileForm(
          {},
          {
            ...defaultEmployeeProfileFormValues,
            name: '财务助手',
            ...invalid,
          },
        ),
      ).toThrow();
  });
});
