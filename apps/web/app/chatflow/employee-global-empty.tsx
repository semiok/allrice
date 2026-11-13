import css from './employee-global-empty.module.css';

export function EmployeeGlobalEmpty() {
  return (
    <section className={css.body} aria-label="AI 员工空态">
      <div className={css.content}>
        <span className={css.mark} aria-hidden="true">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="4" y="7" width="16" height="13" rx="3" />
            <path d="M8 7V4h8v3M4 12h16m-10 0v3h4v-3" />
          </svg>
        </span>
        <h1>AI 员工</h1>
        <p>点卡片上的加号开始</p>
      </div>
    </section>
  );
}
