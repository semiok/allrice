import { LoginForm } from './login-form';

export default function LoginPage() {
  return (
    <main>
      <section className="hero auth-panel">
        <p className="eyebrow">ALLRICE · INVITATION ONLY</p>
        <h1>登录 AllRice</h1>
        <p className="lede">仅限已接受邀请并激活的账号。</p>
        <LoginForm />
      </section>
    </main>
  );
}
