import { headers } from 'next/headers';

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
    <main className="auth-shell">
      <section className="auth-brand-panel">
        <div className="auth-brand-top">
          <span className="auth-mark">R</span>
          <span>ALLRICE / 01</span>
        </div>
        <div className="auth-brand-copy">
          <p className="auth-kicker">AI WORKSPACE FOR CULTURAL BUSINESS</p>
          <h2>
            把每一项工作，<em>交给合适的伙伴。</em>
          </h2>
          <p>
            一个以 AI
            员工为中心的工作台。让任务、资料、记忆和自动化在同一个地方持续推进。
          </p>
        </div>
        <div className="auth-brand-footer">
          <span>WORK / MEMORY / MOMENTUM</span>
          <span>© ALLRICE</span>
        </div>
      </section>
      <section className="auth-form-panel">
        <div className="auth-panel">
          <p className="eyebrow">
            {publicPortal
              ? 'ALLRICE · PRIVATE PORTAL'
              : 'ALLRICE · INVITATION ONLY'}
          </p>
          <h1>{publicPortal?.title ?? '登录工作台'}</h1>
          <p className="lede">
            {publicPortal?.subtitle ?? '仅限已接受邀请并激活的账号。'}
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
          <p className="auth-form-footnote">
            你的工作区数据只会在授权范围内被访问。
          </p>
        </div>
      </section>
    </main>
  );
}
