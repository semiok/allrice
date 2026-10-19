'use client';
import { useId, useState, type ReactNode } from 'react';
import type {
  EmployeeAccentColor,
  EmployeeDetails,
  EmployeeDetailsProfile,
  EmployeeContentReference,
  EmployeeResolvedContent,
  ReferenceSelection,
  ContentOwnership,
} from '@allrice/contracts';
import { employeeAccent, employeeAccentStyle } from './employee-navigation';
import css from './employee-profile-details.module.css';

export interface EmployeeProfileDetailsData {
  name: string;
  description: string;
  appearance?: { accentColor?: EmployeeAccentColor };
  identity: {
    role: string;
    mission: string;
    workStyle: string;
    behaviorRules: string[];
    safetyBoundaries: string[];
  };
  skills: Array<{
    id: string;
    name: string;
    description: string;
  }>;
  model: {
    harness: 'dsh';
    provider: string;
    model: string;
    reasoningEffort: string;
  };
}

const sectionNames = {
  requirements: '执行要求',
  procedures: '执行流程',
  references: '参考资料',
  experience: '经验积累',
};
type Section = keyof typeof sectionNames;
const sectionFor = (kind: EmployeeContentReference['sourceKind']): Section =>
  kind === 'requirement' || kind === 'company_rule'
    ? 'requirements'
    : kind === 'procedure' || kind === 'workflow'
      ? 'procedures'
      : kind === 'knowledge'
        ? 'references'
        : 'experience';
const exactKey = (ref: EmployeeContentReference) =>
  `${ref.sourceKind}/${ref.contentId}/${ref.revisionId}/${ref.digest}`;
const scopeNames = {
  platform: '平台',
  company: '公司',
  department: '部门',
  personal: '个人',
};
const procedureGroups = [
  {
    kind: 'procedure',
    title: '文字流程',
    description: '用文字说明工作方法，由 AI 结合当前任务灵活执行。',
    empty: '暂无已生效的文字流程。',
  },
  {
    kind: 'workflow',
    title: '可执行 Workflow',
    description: '将固定业务流程写成程序，由系统按预设规则执行。',
    empty: '暂无已绑定的可执行 Workflow。',
  },
] as const;

export function ContentSourceBadge({
  scope,
  canMaintain,
}: {
  scope: ContentOwnership['scope'] | null;
  canMaintain: boolean;
}) {
  const maintainable = canMaintain && scope !== null && scope !== 'platform';
  return (
    <span
      className={css.badge}
      data-maintenance={maintainable ? scope : 'readonly'}
    >
      {scope ? scopeNames[scope] : '已有授权引用'} ·{' '}
      {maintainable ? '可维护' : '只读'}
    </span>
  );
}

function ProfileSource({
  profile,
  field,
}: {
  profile: EmployeeDetailsProfile;
  field: EmployeeDetailsProfile['personalFields'][number];
}) {
  const personal = profile.personalFields.includes(field);
  return (
    <ContentSourceBadge
      scope={
        personal
          ? 'personal'
          : profile.source.kind === 'platform'
            ? 'platform'
            : null
      }
      canMaintain={personal && profile.canMaintainPersonal}
    />
  );
}

export function EmployeeProfileDetails({
  details,
  onPreview,
  view = 'personal',
  experienceContent,
}: {
  details: EmployeeDetails;
  onPreview: (reference: ReferenceSelection) => void;
  view?: 'personal' | 'shared';
  experienceContent?: ReactNode;
}) {
  const { profile, content } = details;
  const [section, setSection] = useState<Section>('requirements');
  const [sceneId, setSceneId] = useState('');
  const tabsId = useId();
  const publishedRules = content.platform.revisionId
    ? content.platform.requirements
    : [...profile.identity.behaviorRules, ...profile.identity.safetyBoundaries];
  const scene = content.scenes.find((s) => s.id === sceneId);
  const wanted = new Map(
    [...content.common, ...(scene?.references ?? [])].map((ref) => [
      exactKey(ref),
      ref,
    ]),
  );
  const sources = new Map(
    content.sources.map((source) => [exactKey(source.reference), source]),
  );
  const selected: EmployeeResolvedContent[] = [...wanted].map(
    ([key, ref]) =>
      sources.get(key) ?? {
        reference: ref,
        available: false,
        ownership: null,
        canMaintain: false,
      },
  );
  const rows = selected.filter(
    (source) => sectionFor(source.reference.sourceKind) === section,
  );
  const version =
    profile.source.kind === 'platform'
      ? `平台模板 v${profile.source.templateRevision}`
      : '已配发版本';
  return (
    <div className={css.details}>
      {view === 'shared' && (
        <p className={css.notice}>
          已配发基础人设与公司／部门共享内容。个人名称、人设、偏好、场景和资料由本人查看，不在组织视图中展示。
        </p>
      )}
      <section
        className={css.intro}
        aria-label="基础与人设"
        data-employee-accent={employeeAccent(
          profile.name,
          profile.appearance?.accentColor,
        )}
        style={employeeAccentStyle(
          profile.name,
          profile.appearance?.accentColor,
        )}
      >
        <div className={css.identity}>
          <span className={css.avatar} aria-hidden="true">
            {profile.name.slice(0, 1)}
          </span>
          <div>
            <h3>{profile.name}</h3>
            <p>
              {profile.kind === 'custom' ? '定制 AI 员工' : '通用 AI 员工'} ·{' '}
              {version}
              {view === 'personal'
                ? ` · 个人设置 v${profile.revision}`
                : ' · 共享只读视图'}
            </p>
          </div>
        </div>
        <p>{profile.description}</p>
        <dl className={css.persona}>
          {(
            [
              ['role', '角色'],
              ['mission', '使命'],
              ['workStyle', '工作方式'],
            ] as const
          ).map(([field, label]) => (
            <div key={field}>
              <dt>
                {label}
                <ProfileSource profile={profile} field={field} />
              </dt>
              <dd>{profile.identity[field]}</dd>
            </div>
          ))}
          {profile.expressionStyle && (
            <div>
              <dt>
                表达偏好
                <ProfileSource profile={profile} field="expressionStyle" />
              </dt>
              <dd>
                {
                  {
                    concise: '简洁，结论优先',
                    structured: '结构清晰，分步说明',
                    exploratory: '比较方案与取舍',
                  }[profile.expressionStyle]
                }
              </dd>
            </div>
          )}
        </dl>
        <details className={css.origin}>
          <summary>查看人设来源与版本</summary>
          <p>
            名称
            <ProfileSource profile={profile} field="name" />
          </p>
          <p>
            简介
            <ProfileSource profile={profile} field="description" />
          </p>
          <p>当前配发版本：{profile.source.employeeVersionId}</p>
          {view === 'personal' && <p>个人设置版本：v{profile.revision}</p>}
        </details>
      </section>
      {content.scenes.length > 0 && (
        <label className={css.scene}>
          工作场景（可选）
          <select
            value={sceneId}
            onChange={(event) => setSceneId(event.target.value)}
          >
            <option value="">通用内容</option>
            {content.scenes.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <span>
            {scene ? scene.appliesWhen : '查看所有任务共同采用的要求与资料。'}
          </span>
        </label>
      )}
      {content.scenes.length === 0 && profile.kind === 'custom' && (
        <section className={css.scene} aria-label="工作场景">
          <strong>工作场景</strong>
          <span>
            {view === 'personal'
              ? '暂无已保存的工作场景。'
              : '暂无可查看的共享场景。'}
          </span>
          {view === 'personal' && (
            <span>
              可在聊天中说明希望它负责哪些工作，保存后即生效并显示在这里。
            </span>
          )}
        </section>
      )}
      <div className={css.tabs} role="tablist" aria-label="工作内容">
        {(Object.entries(sectionNames) as [Section, string][]).map(
          ([key, name], index, entries) => (
            <button
              key={key}
              type="button"
              role="tab"
              id={`${tabsId}-${key}`}
              aria-controls={`${tabsId}-panel`}
              aria-selected={section === key}
              tabIndex={section === key ? 0 : -1}
              onClick={() => setSection(key)}
              onKeyDown={(event) => {
                const next =
                  event.key === 'ArrowRight'
                    ? (index + 1) % entries.length
                    : event.key === 'ArrowLeft'
                      ? (index + entries.length - 1) % entries.length
                      : event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? entries.length - 1
                          : -1;
                if (next < 0) return;
                event.preventDefault();
                setSection(entries[next]![0]);
                document
                  .getElementById(`${tabsId}-${entries[next]![0]}`)
                  ?.focus();
              }}
            >
              {name}
            </button>
          ),
        )}
      </div>
      <section
        className={css.content}
        role="tabpanel"
        id={`${tabsId}-panel`}
        aria-labelledby={`${tabsId}-${section}`}
        tabIndex={0}
      >
        {section !== 'procedures' && (
          <p className={css.hint}>
            {scene ? '通用内容与当前场景共同采用。' : '当前已生效的长期内容。'}
            {view === 'personal'
              ? '维护标记表示你的权限，调整请在聊天中说明。'
              : '本视图仅供查看共享内容。'}
          </p>
        )}
        {section === 'experience' &&
          (experienceContent ?? (
            <p className={css.notice}>
              经验整理按生效策略执行；当前未读取到整理状态。
            </p>
          ))}
        {section === 'requirements' && publishedRules.length > 0 && (
          <article className={css.item}>
            <header>
              <h4>
                {content.platform.revisionId ? '平台通用要求' : '历史配发要求'}
              </h4>
              <ContentSourceBadge
                scope={content.platform.revisionId ? 'platform' : null}
                canMaintain={false}
              />
            </header>
            <ul>
              {publishedRules.map((text, i) => (
                <li key={i}>{text}</li>
              ))}
            </ul>
            <details className={css.origin}>
              <summary>查看来源与版本</summary>
              <p>
                来源版本：
                {content.platform.revisionId ??
                  profile.source.employeeVersionId}
              </p>
            </details>
          </article>
        )}
        {section === 'procedures' ? (
          <div className={css.procedureGroups}>
            {procedureGroups.map((group) => {
              const entries = rows.filter(
                (source) => source.reference.sourceKind === group.kind,
              );
              const headingId = `${tabsId}-${group.kind}-heading`;
              return (
                <section
                  key={group.kind}
                  className={css.procedureGroup}
                  aria-labelledby={headingId}
                >
                  <div className={css.procedureIntroduction}>
                    <h3 id={headingId}>{group.title}</h3>
                    <p>{group.description}</p>
                  </div>
                  {entries.length ? (
                    entries.map((source) => (
                      <ContentItem
                        key={exactKey(source.reference)}
                        source={source}
                        onPreview={onPreview}
                      />
                    ))
                  ) : (
                    <p className={css.empty}>{group.empty}</p>
                  )}
                </section>
              );
            })}
          </div>
        ) : (
          rows.map((source) => (
            <ContentItem
              key={exactKey(source.reference)}
              source={source}
              onPreview={onPreview}
            />
          ))
        )}
        {section !== 'procedures' &&
          !rows.length &&
          !(section === 'requirements' && publishedRules.length) && (
            <p className={css.empty}>
              {
                {
                  requirements: '暂无已生效的执行要求。',
                  procedures: '暂无已生效的执行流程。',
                  references: '暂无已引用的参考资料。',
                  experience: '暂无已引用经验。',
                }[section]
              }
            </p>
          )}
      </section>
    </div>
  );
}

function ContentItem({
  source,
  onPreview,
}: {
  source: EmployeeResolvedContent;
  onPreview: (reference: ReferenceSelection) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const procedure =
    source.reference.sourceKind === 'procedure' ||
    source.reference.sourceKind === 'workflow';
  const itemClass = procedure ? `${css.item} ${css.procedureItem}` : css.item;
  if (!source.available)
    return (
      <article className={itemClass}>
        <h4>内容暂不可用</h4>
        <p className={css.hint}>来源已变更或当前无权访问，请联系维护人核对。</p>
      </article>
    );
  return (
    <article className={itemClass}>
      <header>
        <h4>
          {source.referenceFile && !procedure ? (
            <button
              className={css.file}
              type="button"
              onClick={() => onPreview(source.referenceFile!)}
            >
              {source.title}
            </button>
          ) : (
            source.title
          )}
        </h4>
        <div className={procedure ? css.procedureMetadata : undefined}>
          {procedure && (
            <span className={css.procedureStatus}>
              {source.reference.sourceKind === 'workflow' ? '已绑定' : '已生效'}
              {source.referenceFile
                ? ` · v${source.referenceFile.revision}`
                : ''}
            </span>
          )}
          <ContentSourceBadge
            scope={source.ownership?.scope ?? null}
            canMaintain={source.canMaintain}
          />
        </div>
      </header>
      <p className={procedure ? css.procedureBody : css.excerpt}>
        {source.body
          ? procedure
            ? source.body
            : source.body.slice(0, 240) + (source.body.length > 240 ? '…' : '')
          : '暂无内容说明。'}
      </p>
      {!procedure && (
        <details
          className={css.origin}
          onToggle={(event) => setExpanded(event.currentTarget.open)}
        >
          <summary>查看内容与来源</summary>
          {expanded && (
            <>
              <p className={css.fullText}>{source.body}</p>
              <dl>
                <dt>来源</dt>
                <dd>
                  {source.ownership
                    ? scopeNames[source.ownership.scope]
                    : '已有授权引用'}
                </dd>
                <dt>固定版本</dt>
                <dd>
                  {source.referenceFile
                    ? `v${source.referenceFile.revision} · `
                    : ''}
                  {source.reference.revisionId}
                </dd>
              </dl>
            </>
          )}
        </details>
      )}
    </article>
  );
}
