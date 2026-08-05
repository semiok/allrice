import { AcceptInvitationForm } from './accept-form';

export default async function AcceptInvitationPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token = '' } = await searchParams;
  return (
    <main>
      <section className="hero auth-panel">
        <p className="eyebrow">ALLRICE · ACCOUNT ACTIVATION</p>
        <h1>接受邀请</h1>
        <p className="lede">设置独立账号密码并进入获授权的工作空间。</p>
        <AcceptInvitationForm token={token} />
      </section>
    </main>
  );
}
