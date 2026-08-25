import { AcceptInvitationForm } from './accept-form';

export default async function AcceptInvitationPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token = '' } = await searchParams;
  return (
    <main className="auth-shell">
      <section className="auth-brand-panel">
        <div className="auth-brand-top">
          <span className="auth-mark">R</span>
          <span>ALLRICE / 01</span>
        </div>
        <div className="auth-brand-copy">
          <p className="auth-kicker">WELCOME TO YOUR WORKSPACE</p>
          <h2>
            从一次邀请，<em>开始一段长期协作。</em>
          </h2>
          <p>
            激活你的独立账号，选择工作伙伴，把每天重复的工作交给可以持续成长的
            AI 员工。
          </p>
        </div>
        <div className="auth-brand-footer">
          <span>WORK / MEMORY / MOMENTUM</span>
          <span>© ALLRICE</span>
        </div>
      </section>
      <section className="auth-form-panel">
        <div className="auth-panel">
          <p className="eyebrow">ALLRICE · ACCOUNT ACTIVATION</p>
          <h1>接受邀请</h1>
          <p className="lede">设置独立账号密码并进入获授权的工作空间。</p>
          <AcceptInvitationForm token={token} />
          <p className="auth-form-footnote">
            账号创建后，你将直接进入自己的工作台。
          </p>
        </div>
      </section>
    </main>
  );
}
