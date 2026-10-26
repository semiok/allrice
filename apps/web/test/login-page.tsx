// Isolated Chromium entry with the login page's markup and styles; not a Next route.
import { createRoot } from 'react-dom/client';
import { AllriceMark } from '../components/allrice-mark';
import { EmployeeShowcase } from '../app/login/employee-showcase';
import { LoginForm } from '../app/login/login-form';
import '../app/dsh-upstream/design-platform.css';
import '../app/dsh-upstream/base.css';
import '../app/styles/base.css';
import '../app/styles/auth.css';

if (new URLSearchParams(location.search).get('theme') === 'dark')
  document.body.setAttribute('data-ds-dark-theme', '');
createRoot(document.getElementById('root')!).render(
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
          <h1>登录工作台</h1>
          <p className="lede">欢迎回来，使用你的账号继续。</p>
          <LoginForm />
          <p className="auth-form-footnote">还没有账号？请联系你的团队。</p>
        </div>
      </section>
    </div>
  </main>,
);
