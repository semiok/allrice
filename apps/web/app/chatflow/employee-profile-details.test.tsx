import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EmployeeDetailsSchema } from '@allrice/contracts';
import { employeeDetailsFixture } from '../../test/employee-details-fixture';
import {
  ContentSourceBadge,
  EmployeeProfileDetails,
} from './employee-profile-details';

describe('EmployeeProfileDetails', () => {
  it('shows the current persona and personal style, without drafts, another scene or technical settings', () => {
    const html = renderToStaticMarkup(
      <EmployeeProfileDetails
        details={employeeDetailsFixture()}
        onPreview={() => {}}
      />,
    );
    for (const text of [
      'Rice',
      '帮助完成研究',
      '简洁，结论优先',
      '公司核对标准正文',
      '个人输出偏好正文',
      '平台通用要求',
      '参考资料',
      '经验积累',
    ])
      expect(html).toContain(text);
    for (const text of [
      '未启用草稿不能显示',
      '每周核对正文',
      '月度审计正文',
      '撤权后不应看到的标题',
      '技能',
      '模型',
      'Harness',
      '保存草稿',
      '启用按钮',
      '研究助理',
      '查看人设来源与版本',
      '平台模板 v',
      '个人设置 v',
    ])
      expect(html).not.toContain(text);
    expect(html).toContain('内容暂不可用');
    expect(html).toContain('data-maintenance="company"');
    expect(html).toContain('data-maintenance="department"');
    expect(html).toContain('data-maintenance="personal"');
    expect(html).toContain('data-maintenance="readonly"');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<select');
    expect(html).toContain('每周对账');
    expect(html).toContain('每月审计');
    expect(html).toContain('aria-pressed="true"');
  });
  it.each([
    { kind: 'custom', maintain: true, view: 'personal', editable: true },
    { kind: 'general', maintain: true, view: 'personal', editable: false },
    { kind: 'custom', maintain: false, view: 'personal', editable: false },
    { kind: 'custom', maintain: true, view: 'shared', editable: false },
  ] as const)(
    'exposes personal actions only for an authorized custom employee: $kind/$maintain/$view',
    ({ kind, maintain, view, editable }) => {
      const details = employeeDetailsFixture();
      details.profile.kind = kind;
      details.profile.canMaintainPersonal = maintain;
      const html = renderToStaticMarkup(
        <EmployeeProfileDetails
          details={details}
          view={view}
          onPreview={() => {}}
          onEdit={() => {}}
          onPrepare={() => {}}
        />,
      );
      if (editable) {
        expect(html).toContain('编辑');
        expect(html).toContain('AI 新增');
        expect(html).toContain('AI 调整');
      } else {
        expect(html).not.toContain('AI 新增');
        expect(html).not.toContain('AI 调整');
        expect(html).not.toContain('>编辑<');
      }
    },
  );
  it('keeps inherited and unavailable content free of personal adjustment actions', () => {
    const details = employeeDetailsFixture();
    details.profile.kind = 'custom';
    for (const source of details.content.sources)
      if (source.ownership?.scope === 'personal') source.canMaintain = false;
    const html = renderToStaticMarkup(
      <EmployeeProfileDetails
        details={details}
        onPreview={() => {}}
        onPrepare={() => {}}
      />,
    );
    expect(html).toContain('AI 新增');
    expect(html).not.toContain('AI 调整');
    expect(html).not.toContain('撤权后不应看到的标题');
    expect(html).toContain('公司核对标准正文');
    expect(html).toContain('部门指标口径正文');
  });
  it.each(['company', 'department', 'personal', 'platform', null] as const)(
    'renders denied %s sources gray even for a company maintainer',
    (scope) => {
      expect(
        renderToStaticMarkup(
          <ContentSourceBadge scope={scope} canMaintain={false} />,
        ),
      ).toContain('data-maintenance="readonly"');
    },
  );
  it('does not invent scenes for a general employee with no configured content', () => {
    const details = employeeDetailsFixture();
    details.content.scenes = [];
    details.content.common = [];
    details.content.platform.requirements = [];
    const html = renderToStaticMarkup(
      <EmployeeProfileDetails details={details} onPreview={() => {}} />,
    );
    expect(html).not.toContain('<select');
    expect(html).toContain('暂无已生效的执行要求');
  });
  it('keeps common content and allowed actions without empty scene copy in personal or shared view', () => {
    const details = employeeDetailsFixture();
    details.profile.kind = 'custom';
    details.content.scenes = [];
    const personal = renderToStaticMarkup(
      <EmployeeProfileDetails
        details={details}
        onPreview={() => {}}
        onPrepare={() => {}}
      />,
    );
    expect(personal).toContain('工作场景');
    expect(personal).toContain('通用内容');
    expect(personal).not.toContain('暂无已保存的工作场景');
    expect(personal).toContain('AI新增工作场景');
    expect(personal).not.toContain('<select');
    const shared = renderToStaticMarkup(
      <EmployeeProfileDetails
        details={details}
        view="shared"
        onPreview={() => {}}
      />,
    );
    expect(shared).toContain('通用内容');
    expect(shared).not.toContain('暂无可查看的共享场景');
    expect(shared).not.toContain('可在聊天中说明');
    expect(shared).not.toContain('AI新增工作场景');
  });
  it('retains legacy published requirements without inventing platform ownership', () => {
    const details = employeeDetailsFixture();
    details.profile.source = {
      kind: 'tenant_version',
      employeeVersionId: details.profile.source.employeeVersionId,
    };
    details.profile.identity.behaviorRules = ['LEGACY_BEHAVIOR'];
    details.profile.identity.safetyBoundaries = ['LEGACY_BOUNDARY'];
    details.content.platform = {
      ...details.content.platform,
      revisionId: null,
      requirements: [],
    };
    const html = renderToStaticMarkup(
      <EmployeeProfileDetails details={details} onPreview={() => {}} />,
    );
    expect(html).toContain('LEGACY_BEHAVIOR');
    expect(html).toContain('LEGACY_BOUNDARY');
    expect(html).toContain('历史配发要求');
    expect(html).not.toContain('平台通用要求');
  });
  it('rejects a response that combines different instances or includes model configuration', () => {
    const details = employeeDetailsFixture();
    expect(
      EmployeeDetailsSchema.safeParse({
        ...details,
        profile: { ...details.profile, instanceId: details.content.employeeId },
      }).success,
    ).toBe(false);
    expect(
      EmployeeDetailsSchema.safeParse({
        ...details,
        profile: { ...details.profile, model: 'hidden-model' },
      }).success,
    ).toBe(false);
  });
});
