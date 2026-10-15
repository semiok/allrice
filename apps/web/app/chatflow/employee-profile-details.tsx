'use client';
import { useId, useState } from 'react';
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
}: {
  details: EmployeeDetails;
  onPreview: (reference: ReferenceSelection) => void;
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
              {version} · 个人设置 v{profile.revision}
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
          <p>个人设置版本：v{profile.revision}</p>
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
        <p className={css.hint}>
          {scene ? '通用内容与当前场景共同采用。' : '当前已生效的长期内容。'}
          维护标记表示你的权限，调整请在聊天中说明。
        </p>
        {section === 'experience' && (
          <p className={css.notice}>
            自动沉淀尚未启用；这里展示当前已引用的经验。
          </p>
        )}
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
        {rows.map((source) => (
          <ContentItem
            key={exactKey(source.reference)}
            source={source}
            onPreview={onPreview}
          />
        ))}
        {!rows.length &&
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
  if (!source.available)
    return (
      <article className={css.item}>
        <h4>内容暂不可用</h4>
        <p className={css.hint}>来源已变更或当前无权访问，请联系维护人核对。</p>
      </article>
    );
  return (
    <article className={css.item}>
      <header>
        <h4>
          {source.referenceFile ? (
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
        <ContentSourceBadge
          scope={source.ownership?.scope ?? null}
          canMaintain={source.canMaintain}
        />
      </header>
      <p className={css.excerpt}>
        {source.body
          ? source.body.slice(0, 240) + (source.body.length > 240 ? '…' : '')
          : '暂无内容说明。'}
      </p>
      <details
        className={css.origin}
        onToggle={(event) => setExpanded(event.currentTarget.open)}
      >
        <summary>查看内容与来源</summary>
        {expanded && (
          <>
            {source.reference.sourceKind === 'workflow' && (
              <p className={css.hint}>已绑定流程的说明</p>
            )}
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
    </article>
  );
}
