import styles from './dsh-saas.module.css';

export interface EmployeeProfileDetailsData {
  name: string;
  description: string;
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

interface EmployeeProfileDetailsProps {
  profile: EmployeeProfileDetailsData;
}

function providerDisplayName(provider: string) {
  if (provider === 'openai-codex' || provider === 'codex') return 'Codex 订阅';
  if (provider === 'gemini' || provider === 'google') return 'Gemini API';
  if (provider === 'deepseek-official' || provider === 'deepseek') {
    return 'DeepSeek API';
  }
  if (provider === 'openai-compatible') return '兼容 API';
  return provider;
}

function reasoningDisplayName(reasoningEffort: string) {
  return (
    {
      none: '关闭',
      low: '低',
      medium: '中',
      high: '高',
      xhigh: '极高',
    }[reasoningEffort] ?? reasoningEffort
  );
}

export function EmployeeProfileDetails({
  profile,
}: EmployeeProfileDetailsProps) {
  return (
    <>
      <div className={styles.employeeProfileIntro}>
        <span className={styles.employeeProfileAvatar}>
          {profile.name.slice(0, 1)}
        </span>
        <div>
          <strong>{profile.identity.role}</strong>
          <p>{profile.description}</p>
        </div>
        <small>由 AllRice 管理员配置</small>
      </div>

      <section className={styles.employeeProfileSection}>
        <header>
          <span>人设</span>
          <small>Rice 如何理解和完成工作</small>
        </header>
        <dl className={styles.employeePersonaGrid}>
          <div>
            <dt>使命</dt>
            <dd>{profile.identity.mission}</dd>
          </div>
          <div>
            <dt>工作方式</dt>
            <dd>{profile.identity.workStyle}</dd>
          </div>
        </dl>
        {profile.identity.behaviorRules.length ? (
          <div className={styles.employeeRuleList}>
            <strong>行为准则</strong>
            <ul>
              {profile.identity.behaviorRules.map((rule) => (
                <li key={rule}>{rule}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {profile.identity.safetyBoundaries.length ? (
          <div className={styles.employeeRuleList}>
            <strong>工作边界</strong>
            <ul>
              {profile.identity.safetyBoundaries.map((boundary) => (
                <li key={boundary}>{boundary}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <section className={styles.employeeProfileSection}>
        <header>
          <span>技能</span>
          <small>当前发布给本租户的 DSH 原生 Skill</small>
        </header>
        {profile.skills.length ? (
          <div className={styles.employeeSkillList}>
            {profile.skills.map((skill) => (
              <article key={skill.id}>
                <span aria-hidden="true">◇</span>
                <div>
                  <strong>{skill.name}</strong>
                  <p>{skill.description}</p>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <p className={styles.employeeEmptyState}>暂未配置专属技能。</p>
        )}
      </section>

      <section className={styles.employeeProfileSection}>
        <header>
          <span>模型</span>
          <small>平台托管，租户不可修改</small>
        </header>
        <dl className={styles.employeeModelGrid}>
          <div>
            <dt>Harness</dt>
            <dd>DSH</dd>
          </div>
          <div>
            <dt>Provider</dt>
            <dd>{providerDisplayName(profile.model.provider)}</dd>
          </div>
          <div>
            <dt>模型</dt>
            <dd>{profile.model.model}</dd>
          </div>
          <div>
            <dt>推理强度</dt>
            <dd>{reasoningDisplayName(profile.model.reasoningEffort)}</dd>
          </div>
        </dl>
      </section>
    </>
  );
}
