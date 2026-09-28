import { headers } from 'next/headers';
import { AllriceMark } from '../../components/allrice-mark';
import {
  portalAuthEnabled,
  portalPublicView,
  resolvePortal,
} from '../../lib/portal/config';
import { LoginForm } from './login-form';
import { EmployeeShowcase } from './employee-showcase';

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  const portal = portalAuthEnabled()
    ? resolvePortal((await headers()).get('host'))
    : null;
  const publicPortal = portal ? portalPublicView(portal) : null;
  return (
    <main className="auth-shell auth-workspace">
      <header className="auth-workspace-brand">
        <span className="auth-login-brand">
          <AllriceMark size={28} />
          <span className="auth-login-wordmark">AllRice</span>
        </span>
        <span className="auth-brand-slogan" lang="en">
          Do it right. Make it nice.
        </span>
      </header>
      <div className="auth-workspace-columns">
        <section className="auth-workspace-intro" aria-label="Allrice 工作台">
          <h2>
            把工作交给
            <br />
            合适的伙伴。
          </h2>
          <p>
            从一个想法，到一份交付。
            <br />
            和你的 AI 员工一起，把事情做好。
          </p>
          <EmployeeShowcase />
        </section>
        <section className="auth-form-panel">
          <div className="auth-panel">
            <h1>{publicPortal?.title ?? '登录工作台'}</h1>
            <p className="lede">
              {publicPortal?.homePath === '/runtime-console'
                ? publicPortal.subtitle
                : '欢迎回来，使用你的账号继续。'}
            </p>
            <LoginForm
              bootstrap={
                publicPortal
                  ? {
                      username: publicPortal.username,
                      homePath: publicPortal.homePath,
                    }
                  : undefined
              }
            />
            <p className="auth-form-footnote">还没有账号？请联系你的团队。</p>
          </div>
        </section>
      </div>
    </main>
  );
}
