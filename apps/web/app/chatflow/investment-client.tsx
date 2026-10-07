'use client';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type ReactElement,
  cloneElement,
  isValidElement,
} from 'react';
import {
  InvestmentDirectorySchema,
  InvestmentMutationSchema,
  InvestmentRevisionSchema,
  type InvestmentDirectory,
  type InvestmentContent,
  type InvestmentRevision,
} from '@allrice/contracts';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import {
  companyAssetJson,
  companyAssetUrl,
} from './company-template-publisher';
import styles from './company-template-browser.module.css';
export const investmentHeaders: Record<string, string> = {};
export function useInvestmentDirectory(
  base: string,
  headers = investmentHeaders,
) {
  const [snapshot, setSnapshot] = useState<{
    scope: string;
    data: InvestmentDirectory | null;
    error: string;
    loading: boolean;
  }>({ scope: base, data: null, error: '', loading: true });
  const scope = JSON.stringify([base, headers]),
    current = useRef(scope),
    latest = useRef(snapshot),
    controller = useRef<AbortController | null>(null);
  current.current = scope;
  latest.current = snapshot;
  const load = useCallback(
    async (more = false) => {
      const old = latest.current.scope === scope ? latest.current.data : null;
      if (more && !old?.nextCursor) return;
      controller.current?.abort();
      const c = new AbortController();
      controller.current = c;
      setSnapshot({ scope, data: old, error: '', loading: true });
      try {
        const data = InvestmentDirectorySchema.parse(
          await companyAssetJson(
            more ? companyAssetUrl(base, { after: old!.nextCursor! }) : base,
            headers,
            { signal: c.signal },
          ),
        );
        if (c.signal.aborted || current.current !== scope) return;
        setSnapshot({
          scope,
          data: more
            ? {
                ...data,
                entries: [
                  ...new Map(
                    [...old!.entries, ...data.entries].map((r) => [r.id, r]),
                  ).values(),
                ],
              }
            : data,
          error: '',
          loading: false,
        });
      } catch (e) {
        if (!c.signal.aborted && current.current === scope)
          setSnapshot({
            scope,
            data:
              e &&
              typeof e === 'object' &&
              'status' in e &&
              [401, 403, 404].includes(Number(e.status))
                ? null
                : old,
            error: e instanceof Error ? e.message : '读取失败',
            loading: false,
          });
      }
    },
    [base, headers, scope],
  );
  useEffect(() => {
    void load();
    return () => controller.current?.abort();
  }, [load]);
  return {
    ...(snapshot.scope === scope
      ? snapshot
      : { data: null, error: '', loading: true }),
    load,
  };
}
/** An ambiguous write is read back using its stable identity; never repeated automatically. */
export async function saveInvestment(
  base: string,
  headers: Record<string, string>,
  entryId: string,
  expectedRevision: number,
  content: InvestmentContent,
) {
  const mutation = InvestmentMutationSchema.parse({
    entryId,
    expectedRevision,
    content,
  });
  try {
    return InvestmentRevisionSchema.parse(
      await companyAssetJson(base, headers, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mutation),
      }),
    );
  } catch (error) {
    const data = await companyAssetJson(
      companyAssetUrl(base, { entryId }),
      headers,
    )
      .then((v) => InvestmentDirectorySchema.parse(v))
      .catch(() => null);
    const found = data?.entries.find(
      (r) =>
        r.entryId === entryId &&
        r.number === expectedRevision + 1 &&
        JSON.stringify(r.content) === JSON.stringify(mutation.content),
    );
    if (found) return found;
    throw error;
  }
}
export function InvestmentField({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label>
      {label}
      {isValidElement(children)
        ? cloneElement(children as ReactElement<{ 'aria-label'?: string }>, {
            'aria-label': label,
          })
        : children}
    </label>
  );
}
export const numeric = (value: string) =>
  value.trim() === '' ? null : Number(value);
export const money = (value: string) =>
  value.trim() === '' ? null : Math.round(Number(value) * 100);
export const numberText = (n: number | null | undefined) =>
  n === null || n === undefined ? '' : String(n);
export function InvestmentHistory({
  base,
  headers = investmentHeaders,
  entry,
}: {
  base: string;
  headers?: Record<string, string>;
  entry: InvestmentRevision;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen((v) => !v)}>
        {open ? '收起' : '查看'}修订记录 · v{entry.number}
      </Button>
      {open && (
        <HistoryRows
          key={entry.entryId}
          base={companyAssetUrl(base, { entryId: entry.entryId, history: '1' })}
          headers={headers}
        />
      )}
    </>
  );
}
function HistoryRows({
  base,
  headers,
}: {
  base: string;
  headers: Record<string, string>;
}) {
  const list = useInvestmentDirectory(base, headers);
  return (
    <section aria-label="登记修订记录">
      {list.error && <p role="alert">{list.error}</p>}
      {list.data?.entries
        .slice()
        .sort((a, b) => b.number - a.number)
        .map((r) => (
          <div className={styles.item} key={r.id}>
            <strong>
              v{r.number} · {new Date(r.createdAt).toLocaleString()}
            </strong>
            <p>{r.content.source}</p>
            {r.content.kind === 'work' ? (
              <p>
                采用：
                {r.content.adoptedAt
                  ? new Date(r.content.adoptedAt).toLocaleString()
                  : '未确认'}{' '}
                · 实际人工{' '}
                {r.content.humanMinutes === null
                  ? '未知'
                  : r.content.humanMinutes + ' 分钟'}{' '}
                · {r.content.humanScope === 'complete' ? '全流程' : '仅复核'} ·
                基准版本{' '}
                {r.facts.baselineRevisionId
                  ? String(r.facts.baselineRevisionId).slice(0, 8)
                  : '未选'}
              </p>
            ) : r.content.kind === 'baseline' ? (
              <p>
                人工基准 {r.content.minutesPerUnit} 分钟/{r.content.unit} · 费率{' '}
                {r.content.hourlyRateMinor === null
                  ? '未知'
                  : r.content.hourlyRateMinor / 100 +
                    ' ' +
                    r.content.currency +
                    '/小时'}
              </p>
            ) : (
              <p>
                期间 {new Date(r.content.from).toLocaleDateString()} —{' '}
                {new Date(r.content.to).toLocaleDateString()} ·{' '}
                {r.content.currency}
              </p>
            )}
            {r.content.kind === 'expense' && (
              <p>
                总费用 {r.content.amountMinor / 100} {r.content.currency} ·
                公司分摊合计{' '}
                {r.content.allocations.reduce(
                  (sum, a) => sum + a.amountMinor,
                  0,
                ) / 100}{' '}
                {r.content.currency} · {r.content.allocations.length} 家公司
              </p>
            )}
            {r.content.kind === 'statement' && (
              <p>
                模型费用{' '}
                {r.content.modelMinor === null
                  ? '未知'
                  : r.content.modelMinor / 100}{' '}
                · 其他投入{' '}
                {r.content.otherMinor === null
                  ? '未知'
                  : r.content.otherMinor / 100}{' '}
                · 订阅{' '}
                {r.content.subscriptionKnown
                  ? '已核实，所选凭据固定为当时版本'
                  : '未知'}{' '}
                · {r.content.currency} ·{' '}
                {r.content.coverage === 'complete'
                  ? '已声明覆盖完整'
                  : '覆盖部分'}
              </p>
            )}
            <small>证据摘要 {r.digest.slice(0, 23)}…</small>
          </div>
        ))}
      {list.data?.nextCursor && (
        <Button disabled={list.loading} onClick={() => void list.load(true)}>
          更多修订
        </Button>
      )}
    </section>
  );
}
