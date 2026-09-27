import { headers } from 'next/headers';
import { AllriceBrand } from '../../components/allrice-brand';
import {
  portalAuthEnabled,
  portalPublicView,
  resolvePortal,
} from '../../lib/portal/config';
import { LoginForm } from './login-form';

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  const portal = portalAuthEnabled()
    ? resolvePortal((await headers()).get('host'))
    : null;
  const publicPortal = portal ? portalPublicView(portal) : null;
  return (
    <main className="auth-shell auth-workspace">
      <header className="auth-workspace-brand">
        <AllriceBrand />
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
          <div className="auth-employee-list" aria-label="AI 员工示例">
            <div className="auth-employee">
              <span className="auth-employee-avatar" aria-hidden="true">
                R
              </span>
              <div>
                <strong>Rice</strong>
                <span>研究、分析与日常工作</span>
              </div>
            </div>
            <div className="auth-employee">
              <span
                className="auth-employee-avatar auth-employee-office"
                aria-hidden="true"
              >
                O
              </span>
              <div>
                <strong>Office 文档助手</strong>
                <span>文档、表格与演示文稿</span>
              </div>
            </div>
          </div>
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
