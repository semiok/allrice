const capabilities = [
  ['Identity', 'Invitation and RBAC baseline implemented in MET-41'],
  ['Employee workspace', 'Implemented in MET-50'],
  ['Persistent Worker', 'Durable execution plane implemented in MET-43'],
  ['SkillHub', 'Codex subscription vertical slice implemented in MET-44'],
];

export default function HomePage() {
  return (
    <main>
      <section className="hero">
        <p className="eyebrow">ALLRICE 0.1.0 · ENGINEERING BASELINE</p>
        <h1>企业员工的 AI 工作空间</h1>
        <p className="lede">
          当前版本建立 Web、Worker、PostgreSQL、Storage
          与运行文档基线。员工功能将在契约冻结后按 Linear Issue 分阶段交付。
        </p>
        <div className="status">
          <span className="dot" />
          Web process is running
        </div>
        <div className="home-actions">
          <a href="/workspace">进入员工工作台</a>
          <a href="/login">登录</a>
        </div>
      </section>

      <section className="grid" aria-label="Capability status">
        {capabilities.map(([name, state]) => (
          <article key={name}>
            <h2>{name}</h2>
            <p>{state}</p>
          </article>
        ))}
      </section>
    </main>
  );
}
