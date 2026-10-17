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
      '研究助理',
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
    ])
      expect(html).not.toContain(text);
    expect(html).toContain('内容暂不可用');
    expect(html).toContain('data-maintenance="company"');
    expect(html).toContain('data-maintenance="department"');
    expect(html).toContain('data-maintenance="personal"');
    expect(html).toContain('data-maintenance="readonly"');
    expect(html).not.toContain('<form');
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
  it('explains an empty custom scene list without inventing active content or exposing private state in shared view', () => {
    const details = employeeDetailsFixture();
    details.profile.kind = 'custom';
    details.content.scenes = [];
    const personal = renderToStaticMarkup(
      <EmployeeProfileDetails details={details} onPreview={() => {}} />,
    );
    expect(personal).toContain('工作场景');
    expect(personal).toContain('暂无已保存的工作场景');
    expect(personal).toContain('保存后即生效并显示在这里');
    expect(personal).toContain('可在聊天中说明希望它负责哪些工作');
    expect(personal).not.toContain('<select');
    const shared = renderToStaticMarkup(
      <EmployeeProfileDetails
        details={details}
        view="shared"
        onPreview={() => {}}
      />,
    );
    expect(shared).toContain('暂无可查看的共享场景');
    expect(shared).not.toContain('可在聊天中说明');
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
