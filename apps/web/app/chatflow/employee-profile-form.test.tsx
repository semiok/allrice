import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  EmployeeInstanceProfileSchema,
  employeeColorPalette,
} from '@allrice/contracts';
import { employeeDetailsFixture } from '../../test/employee-details-fixture';
import {
  EmployeeProfileForm,
  defaultEmployeeProfileFormValues,
  employeeProfileFormFromRaw,
  mergeEmployeeProfileForm,
} from './employee-profile-form';

describe('shared employee profile form', () => {
  it('uses the same named fields and ten approved colors for creation and editing', () => {
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
        '员工名字',
        '头像颜色',
        '使命',
        '工作方式',
        '表达偏好',
      ])
        expect(html).toContain(label);
      expect(html).toContain(
        'placeholder="例如： 文案专家、财务助手、商务分析师"',
      );
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
