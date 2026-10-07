'use client';
import { useState } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import {
  InvestmentReportSchema,
  type InvestmentExpense,
  type InvestmentStatement,
  type InvestmentContent,
  type InvestmentRevision,
  type OrganizationActivityOverview,
} from '@allrice/contracts';
import { DshDialog } from '../chatflow/dsh-upstream/Dialog';
import { companyAssetUrl } from '../chatflow/company-template-publisher';
import {
  useInvestmentDirectory,
  saveInvestment,
  investmentHeaders,
  InvestmentHistory,
  InvestmentField as Field,
  numeric,
  money,
} from '../chatflow/investment-client';
import { useActivityPages } from './organization-activity-data';
import forms from '../chatflow/company-template-browser.module.css';
import css from './company-dashboard.module.css';
const display = (n: number | null, suffix = '') =>
  n === null
    ? '未知'
    : n.toLocaleString(undefined, { maximumFractionDigits: 2 }) + suffix;
const amount = (n: number | null, currency: string) =>
  n === null ? '未知' : display(n / 100, ' ' + currency);
const missingLabels = {
  not_adopted: '未确认采用',
  baseline_missing: '未选择人工基准',
  human_input_missing: '人工投入未知',
  human_scope_incomplete: '仅记录了部分人工投入',
  source_unavailable: '来源成果不可用',
  calculation_out_of_range: '数值超出精确范围',
};
export function CompanyInvestment({
  organizationId,
  period,
  filters,
  custom,
}: {
  organizationId: string;
  period: { from: string; to: string; timeZone: string };
  filters: string;
  custom: boolean;
}) {
  const base = `/api/v1/admin/organizations/${organizationId}/investment?directory=1`,
    query = new URLSearchParams({ report: '1', range: 'custom', ...period });
  new URLSearchParams(filters).forEach((value, key) => query.set(key, value));
  const summary = useActivityPages<Record<string, unknown>>(
      companyAssetUrl(base, Object.fromEntries(query)),
    ),
    parsed = summary.data
      ? InvestmentReportSchema.safeParse(summary.data)
      : null,
    report = parsed?.success ? parsed.data : null;
  const list = useInvestmentDirectory(base),
    [editor, setEditor] = useState<{
      kind: 'baseline' | 'expense' | 'statement';
      entry?: InvestmentRevision;
    } | null>(null);
  return (
    <section className={css.investment} aria-label="人工确认的投入与收益估算">
      <h4>投入与收益估算</h4>
      <p className={css.caption}>
        仅使用明确采用的成果、人工基准与实际人工投入。未知项保留，负收益照实展示；不同币种分别计算。
      </p>
      <div className={forms.actions}>
        <Button onClick={() => setEditor({ kind: 'baseline' })}>
          新建人工基准
        </Button>
        <Button
          disabled={!custom}
          onClick={() => setEditor({ kind: 'expense' })}
        >
          登记订阅费用
        </Button>
        <Button
          disabled={!custom}
          onClick={() =>
            setEditor({
              kind: 'statement',
              entry:
                report?.groups.find((g) => g.currency === 'CNY')?.statement ??
                undefined,
            })
          }
        >
          确认本期投入
        </Button>
        <Button
          disabled={summary.loading}
          onClick={() => {
            void summary.load();
            void list.load();
          }}
        >
          刷新估算与登记
        </Button>
        <a
          href={companyAssetUrl(base, {
            ...Object.fromEntries(query),
            export: '1',
          })}
        >
          导出估算与完整证据
        </a>
      </div>
      {!custom && (
        <p className={css.caption}>
          确认费用前，请在看板选用并应用自定义时间范围，使费用与收益使用相同的固定周期。
        </p>
      )}
      {(summary.error || list.error || (parsed && !parsed.success)) && (
        <p role="alert">
          {summary.error || list.error || '估算响应不完整，请刷新核对。'}
        </p>
      )}
      {report && (
        <>
          <p>
            已登记业务 {report.candidateWorks} 项 · 可估算工时{' '}
            {report.includedWorks} 项
            {report.truncated ? ' · 样本超出单次 1000 项上限，合计暂未知' : ''}
          </p>
          <div className={css.facts}>
            <section>
              <h4>节省工时</h4>
              <p>{display(report.savedMinutes, ' 分钟')}</p>
              <small>人工基准 × 业务数量 − 实际完整人工投入</small>
            </section>
            <section>
              <h4>工时等效</h4>
              <p>{display(report.hoursEquivalent)}</p>
              <small>
                {report.standardHours === null
                  ? '标准工时未配置，或各币种的声明不一致'
                  : `本期标准 ${report.standardHours} 小时；仅为工时折算，不代表替代人数。`}
              </small>
            </section>
          </div>
          {report.groups.map((g) => (
            <div className={forms.item} key={g.currency}>
              <h4>{g.currency} · 估算收益</h4>
              <p>
                人工价值 {amount(g.valueMinor, g.currency)} · 已估价{' '}
                {g.valuedWorks} 项 · 未估价 {g.unvaluedWorks} 项 ·{' '}
                {g.valueCoverage === 'complete'
                  ? '样本估价完整'
                  : g.valueCoverage === 'partial'
                    ? '只含已知部分'
                    : '估价未知'}
              </p>
              <p>
                模型 {amount(g.modelMinor, g.currency)} · 订阅分摊{' '}
                {amount(g.subscriptionMinor, g.currency)} · 其他{' '}
                {amount(g.otherMinor, g.currency)}
              </p>
              <p>
                投入合计 {amount(g.costMinor, g.currency)}（
                {g.costCoverage === 'complete'
                  ? '已声明完整'
                  : g.costCoverage === 'partial'
                    ? '覆盖部分'
                    : '未知'}
                ） · 收益/投入 {display(g.ratio)} · ROI{' '}
                {g.roi === null ? '未知' : display(g.roi * 100, '%')}
              </p>
              {g.excludedCosts.map((note) => (
                <small key={note}>{note}；</small>
              ))}
              {g.statement && (
                <InvestmentHistory base={base} entry={g.statement} />
              )}
            </div>
          ))}
          {!report.groups.length && (
            <p>尚无币种与估价依据，收益和费用均未知。</p>
          )}
          <details>
            <summary>查看覆盖范围与未计入原因</summary>
            <p>{report.scopeNote}</p>
            {Object.entries(report.missing).map(([reason, n]) => (
              <p key={reason}>
                {missingLabels[reason as keyof typeof missingLabels]}：{n} 项
              </p>
            ))}
            <p>
              规则版本：{report.algorithm} ·
              导出文件包含采用版本、来源、基准与费用修订。
            </p>
          </details>
        </>
      )}
      <details>
        <summary>管理基准、费用及查看业务登记</summary>
        <div className={forms.editor}>
          {list.data?.entries.map((r) => (
            <div key={r.id} className={forms.item}>
              <strong>
                {r.content.title} ·{' '}
                {
                  {
                    baseline: '人工基准',
                    expense: '订阅费用',
                    statement: '本期投入',
                    work: '业务采用',
                  }[r.content.kind]
                }{' '}
                · v{r.number}
              </strong>
              <p>{r.content.source}</p>
              {r.content.kind !== 'work' && (
                <Button
                  onClick={() =>
                    setEditor({
                      kind: r.content.kind as
                        'baseline' | 'expense' | 'statement',
                      entry: r,
                    })
                  }
                >
                  编辑并保存新修订
                </Button>
              )}
              <InvestmentHistory base={base} entry={r} />
            </div>
          ))}
          {list.data?.nextCursor && (
            <Button
              disabled={list.loading}
              onClick={() => void list.load(true)}
            >
              加载更多登记
            </Button>
          )}
        </div>
      </details>
      {editor && (
        <DshDialog
          ariaLabel="收益估算依据登记"
          title={
            {
              baseline: '人工处理基准',
              expense: '订阅费用与公司分摊',
              statement: '本期投入依据',
            }[editor.kind]
          }
          className={forms.dialog}
          bodyClassName={forms.body}
          onClose={() => setEditor(null)}
        >
          <InvestmentEditor
            key={editor.entry?.id ?? editor.kind}
            {...editor}
            organizationId={organizationId}
            base={base}
            period={period}
            entries={list.data?.entries ?? []}
            onSaved={() => {
              setEditor(null);
              void list.load();
              void summary.load();
            }}
          />
        </DshDialog>
      )}
    </section>
  );
}
function InvestmentEditor({
  kind,
  entry,
  organizationId,
  base,
  period,
  entries,
  onSaved,
}: {
  kind: 'baseline' | 'expense' | 'statement';
  entry?: InvestmentRevision;
  organizationId: string;
  base: string;
  period: { from: string; to: string };
  entries: InvestmentRevision[];
  onSaved: () => void;
}) {
  const old = entry?.content,
    [id] = useState(() => entry?.entryId ?? crypto.randomUUID()),
    [values, setValues] = useState<Record<string, string>>(() => ({
      title: old?.title ?? '',
      source: old?.source ?? '',
      key: old?.kind === 'baseline' ? old.key : '',
      taskType: old?.kind === 'baseline' ? old.taskType : '',
      unit: old?.kind === 'baseline' ? old.unit : '份',
      minutes: old?.kind === 'baseline' ? String(old.minutesPerUnit) : '',
      rate:
        old?.kind === 'baseline' && old.hourlyRateMinor !== null
          ? String(old.hourlyRateMinor / 100)
          : '',
      currency: old && 'currency' in old ? (old.currency ?? 'CNY') : 'CNY',
      receipt: old?.kind === 'expense' ? old.receiptKey : '',
      total: old?.kind === 'expense' ? String(old.amountMinor / 100) : '',
      from: old && 'from' in old ? old.from : period.from,
      to: old && 'to' in old ? old.to : period.to,
      model:
        old?.kind === 'statement' && old.modelMinor !== null
          ? String(old.modelMinor / 100)
          : '',
      other:
        old?.kind === 'statement' && old.otherMinor !== null
          ? String(old.otherMinor / 100)
          : '',
      subscriptionKnown:
        old?.kind === 'statement' && old.subscriptionKnown ? 'yes' : 'no',
      coverage: old?.kind === 'statement' ? old.coverage : 'partial',
      hours:
        old?.kind === 'statement' && old.standardHours !== null
          ? String(old.standardHours)
          : '',
    })),
    [allocations, setAllocations] = useState(
      old?.kind === 'expense'
        ? old.allocations.map((a) => ({
            organizationId: a.organizationId,
            amount: String(a.amountMinor / 100),
          }))
        : [{ organizationId, amount: '' }],
    ),
    [selected, setSelected] = useState(
      old?.kind === 'statement' ? old.subscriptionRevisionIds : [],
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const companies = useActivityPages<OrganizationActivityOverview>(
    '/api/v1/admin/activity?view=companies',
    'organizations',
  );
  const field = (
    label: string,
    key: string,
    type = 'text',
    required = true,
    disabled = false,
  ) => (
    <Field label={label}>
      <input
        type={type}
        required={required}
        disabled={busy || disabled}
        min={type === 'number' ? 0 : undefined}
        step={type === 'number' ? 'any' : undefined}
        maxLength={500}
        value={values[key] ?? ''}
        onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
      />
    </Field>
  );
  const select = (
    label: string,
    key: string,
    options: Record<string, string>,
    disabled = false,
  ) => (
    <Field label={label}>
      <select
        value={values[key]}
        disabled={busy || disabled}
        onChange={(e) => {
          setValues((v) => ({ ...v, [key]: e.target.value }));
          if (key === 'currency') setSelected([]);
        }}
      >
        {Object.entries(options).map(([value, text]) => (
          <option key={value} value={value}>
            {text}
          </option>
        ))}
      </select>
    </Field>
  );
  const fees = entries.filter(
    (r): r is InvestmentRevision & { content: InvestmentExpense } =>
      r.content.kind === 'expense' &&
      r.content.currency === values.currency &&
      Date.parse(r.content.from) === Date.parse(values.from!) &&
      Date.parse(r.content.to) === Date.parse(values.to!) &&
      r.content.allocations.some((a) => a.organizationId === organizationId),
  );
  return (
    <form
      className={forms.editor}
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy) return;
        setBusy(true);
        setError('');
        try {
          const currency = values.currency === 'USD' ? 'USD' : 'CNY';
          let content: InvestmentContent;
          if (kind === 'baseline')
            content = {
              kind,
              key: values.key!,
              title: values.title!,
              taskType: values.taskType!,
              unit: values.unit!,
              minutesPerUnit: Number(values.minutes),
              hourlyRateMinor: money(values.rate!),
              currency: values.rate!.trim() ? currency : null,
              source: values.source!,
            };
          else if (kind === 'expense')
            content = {
              kind,
              receiptKey: values.receipt!,
              title: values.title!,
              from: values.from!,
              to: values.to!,
              currency,
              amountMinor: money(values.total!)!,
              allocations: allocations.map((a) => ({
                organizationId: a.organizationId,
                amountMinor: money(a.amount)!,
              })),
              source: values.source!,
            };
          else
            content = {
              kind,
              title: values.title!,
              from: values.from!,
              to: values.to!,
              currency,
              modelMinor: money(values.model!),
              otherMinor: money(values.other!),
              subscriptionKnown: values.subscriptionKnown === 'yes',
              subscriptionRevisionIds: selected,
              coverage: values.coverage as InvestmentStatement['coverage'],
              standardHours: numeric(values.hours!),
              source: values.source!,
            };
          await saveInvestment(
            base,
            investmentHeaders,
            entry?.entryId ?? id,
            entry?.number ?? 0,
            content,
          );
          onSaved();
        } catch (e) {
          setError(e instanceof Error ? e.message : '保存失败，请刷新核对。');
        } finally {
          setBusy(false);
        }
      }}
    >
      <p>
        每次保存都保留旧版本。人工基准的变更不会改写已登记样本；历史费用声明保留当时的分摊版本。同一周期和币种已有声明时，请从目录选择并核对后编辑。
      </p>
      {field('名称', 'title')}
      {kind === 'baseline' ? (
        <>
          {field('基准标识', 'key')}
          {field('职能场景', 'taskType')}
          {field('计量单位', 'unit')}
          {field('每单位人工处理时间（分钟）', 'minutes', 'number')}
          {field('人工费率（每小时；留空未知）', 'rate', 'number', false)}
          {select('费率币种', 'currency', {
            CNY: 'CNY 人民币',
            USD: 'USD 美元',
          })}
        </>
      ) : (
        <>
          <p>
            费用周期：{new Date(values.from!).toLocaleString()} —{' '}
            {new Date(values.to!).toLocaleString()}
          </p>
          {select(
            '票据原币种（分别计算，不做汇率换算）',
            'currency',
            { CNY: 'CNY 人民币', USD: 'USD 美元' },
            !!entry,
          )}
        </>
      )}
      {kind === 'expense' && (
        <>
          {field(
            '费用凭据标识（同一张账单只登记一次）',
            'receipt',
            'text',
            true,
            !!entry,
          )}
          {field('总费用（所选币种）', 'total', 'number')}
          <fieldset>
            <legend>公司分摊</legend>
            {allocations.map((a, i) => (
              <div className={forms.slot} key={i}>
                <Field label="分摊公司">
                  <select
                    required
                    value={a.organizationId}
                    onChange={(e) =>
                      setAllocations((rows) =>
                        rows.map((r, index) =>
                          index === i
                            ? { ...r, organizationId: e.target.value }
                            : r,
                        ),
                      )
                    }
                  >
                    {!companies.data?.organizations.some(
                      (o) => o.id === a.organizationId,
                    ) && (
                      <option value={a.organizationId}>
                        {a.organizationId === organizationId
                          ? '当前公司'
                          : '已选公司'}
                      </option>
                    )}
                    {companies.data?.organizations.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="分摊金额">
                  <input
                    type="number"
                    required
                    min="0"
                    step="0.01"
                    value={a.amount}
                    onChange={(e) =>
                      setAllocations((rows) =>
                        rows.map((r, index) =>
                          index === i ? { ...r, amount: e.target.value } : r,
                        ),
                      )
                    }
                  />
                </Field>
                <Button
                  onClick={() =>
                    setAllocations((rows) =>
                      rows.filter((_, index) => index !== i),
                    )
                  }
                >
                  移除分摊
                </Button>
              </div>
            ))}
            <Button
              onClick={() =>
                setAllocations((rows) => [
                  ...rows,
                  { organizationId: '', amount: '' },
                ])
              }
            >
              添加公司分摊
            </Button>
            {companies.data?.nextCursor && (
              <Button
                disabled={companies.loading}
                onClick={() => void companies.load(true)}
              >
                更多公司
              </Button>
            )}
            {companies.error && <p role="alert">{companies.error}</p>}
            <p>分摊总和不得超过总费用；已冻结到公司声明的分摊也计入上限。</p>
          </fieldset>
        </>
      )}
      {kind === 'statement' && (
        <>
          {field(
            '模型费用（留空未知；0 为有依据的零费用）',
            'model',
            'number',
            false,
          )}
          {field('其他投入（留空未知）', 'other', 'number', false)}
          {select(
            '订阅投入是否已经核实（没有订阅时也需确认）',
            'subscriptionKnown',
            { no: '尚未核实，投入未知', yes: '已核实，以勾选的分摊为依据' },
          )}
          <fieldset>
            <legend>同周期、同币种的订阅分摊</legend>
            {fees.map((r) => (
              <label key={r.id}>
                <input
                  type="checkbox"
                  style={{ width: 'auto', justifySelf: 'start' }}
                  checked={selected.includes(r.id)}
                  onChange={(e) =>
                    setSelected((ids) =>
                      e.target.checked
                        ? [...ids, r.id]
                        : ids.filter((id) => id !== r.id),
                    )
                  }
                />
                {r.content.title} · v{r.number} ·{' '}
                {r.content.allocations.find(
                  (a) => a.organizationId === organizationId,
                )!.amountMinor / 100}{' '}
                {r.content.currency}
              </label>
            ))}
            {!fees.length && (
              <p>
                尚无已加载且匹配的订阅凭据。请先在目录登记费用并加载完整目录。
              </p>
            )}
            {selected
              .filter((id) => !fees.some((r) => r.id === id))
              .map((id) => (
                <label key={id}>
                  <input
                    type="checkbox"
                    style={{ width: 'auto', justifySelf: 'start' }}
                    checked
                    onChange={() =>
                      setSelected((ids) => ids.filter((x) => x !== id))
                    }
                  />
                  历史分摊版本 {id.slice(0, 8)}：新保存需重新核对并选择最新版
                </label>
              ))}
          </fieldset>
          {select('投入覆盖范围', 'coverage', {
            partial: '部分投入，完整 ROI 未知',
            complete: '已确认本期所有相关投入',
          })}
          {field('本期每人标准工时（小时，可选）', 'hours', 'number', false)}
        </>
      )}
      <Field label="依据与来源说明">
        <textarea
          required
          rows={3}
          maxLength={500}
          value={values.source}
          onChange={(e) => setValues((v) => ({ ...v, source: e.target.value }))}
        />
      </Field>
      <Button type="submit" disabled={busy}>
        {busy ? '正在保存…' : '保存新修订'}
      </Button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
