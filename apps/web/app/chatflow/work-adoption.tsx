'use client';
import { useEffect, useState } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import type { InvestmentRevision, InvestmentWork } from '@allrice/contracts';
import { DshDialog } from './dsh-upstream/Dialog';
import { companyAssetUrl } from './company-template-publisher';
import {
  useInvestmentDirectory,
  saveInvestment,
  InvestmentField as Field,
  InvestmentHistory,
  numeric,
  numberText,
} from './investment-client';
import styles from './company-template-browser.module.css';
export function WorkAdoption(props: {
  workspaceId: string;
  headers: Record<string, string>;
  versionId: string;
  fileName: string;
  runId: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>登记采用与投入</Button>
      {open && (
        <DshDialog
          ariaLabel="登记成果采用"
          title="登记采用与实际人工投入"
          className={styles.dialog}
          bodyClassName={styles.body}
          onClose={() => setOpen(false)}
        >
          <AdoptionEditor {...props} />
        </DshDialog>
      )}
    </>
  );
}
function AdoptionEditor(props: Parameters<typeof WorkAdoption>[0]) {
  const base = `/api/v1/investment?workspaceId=${encodeURIComponent(props.workspaceId)}`,
    list = useInvestmentDirectory(base, props.headers),
    linked = useInvestmentDirectory(
      companyAssetUrl(base, { sourceVersionId: props.versionId, kind: 'work' }),
      props.headers,
    );
  const [selected, setSelected] = useState(''),
    [saved, setSaved] = useState<InvestmentRevision | null>(null);
  useEffect(() => {
    if (linked.data?.entries[0]) setSelected(linked.data.entries[0].entryId);
  }, [linked.data]);
  const records = [
      ...new Map(
        [
          ...(list.data?.entries ?? []),
          ...(linked.data?.entries ?? []),
          ...(saved ? [saved] : []),
        ].map((r) => [r.entryId, r]),
      ).values(),
    ],
    current = records.find((r) => r.entryId === selected),
    baselines = records.filter((r) => r.content.kind === 'baseline');
  return (
    <div className={styles.editor}>
      <p>
        只记录你明确采用的这个成果版本。同一项业务分多轮完成时，归并到同一业务标识；人工投入包含准备、复核和返工。
      </p>
      {(list.error || linked.error) && (
        <p role="alert">{list.error || linked.error}</p>
      )}
      <Field label="业务工作">
        <select
          value={selected}
          disabled={!!linked.data?.entries.length}
          onChange={(e) => {
            setSelected(e.target.value);
            setSaved(null);
          }}
        >
          <option value="">新建业务工作</option>
          {records
            .filter((r) => r.content.kind === 'work')
            .map((r) => (
              <option key={r.entryId} value={r.entryId}>
                {r.content.title} · {(r.content as InvestmentWork).key}
              </option>
            ))}
        </select>
      </Field>
      {list.data?.nextCursor && (
        <Button disabled={list.loading} onClick={() => void list.load(true)}>
          加载更多业务及基准
        </Button>
      )}
      {list.data && linked.data && (
        <WorkForm
          key={current?.id ?? 'new'}
          {...props}
          base={base}
          current={current}
          baselines={baselines}
          onSaved={(r) => {
            setSaved(r);
            setSelected(r.entryId);
            void list.load();
            void linked.load();
          }}
        />
      )}
      {current && (
        <InvestmentHistory
          base={base}
          headers={props.headers}
          entry={current}
        />
      )}
    </div>
  );
}
function WorkForm({
  base,
  current,
  baselines,
  onSaved,
  ...props
}: Parameters<typeof WorkAdoption>[0] & {
  base: string;
  current: InvestmentRevision | undefined;
  baselines: InvestmentRevision[];
  onSaved: (r: InvestmentRevision) => void;
}) {
  const old = current?.content as InvestmentWork | undefined,
    [entryId] = useState(() => current?.entryId ?? crypto.randomUUID());
  const [key, setKey] = useState(old?.key ?? ''),
    [title, setTitle] = useState(old?.title ?? props.fileName),
    [units, setUnits] = useState(String(old?.units ?? 1)),
    [minutes, setMinutes] = useState(numberText(old?.humanMinutes)),
    [baseline, setBaseline] = useState(old?.baselineRevisionId ?? ''),
    [scope, setScope] = useState(old?.humanScope ?? 'complete'),
    [adopted, setAdopted] = useState(!!old?.adoptedAt),
    [date, setDate] = useState(() => {
      const d = old?.adoptedAt ? new Date(old.adoptedAt) : new Date();
      return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 16);
    }),
    [source, setSource] = useState(old?.source ?? ''),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  return (
    <form
      className={styles.editor}
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy) return;
        setBusy(true);
        setMessage('');
        try {
          const r = await saveInvestment(
            base,
            props.headers,
            entryId,
            current?.number ?? 0,
            {
              kind: 'work',
              key,
              title,
              units: Number(units),
              sourceRunIds: [
                ...new Set([...(old?.sourceRunIds ?? []), props.runId]),
              ],
              sourceVersionId: props.versionId,
              baselineRevisionId: baseline || null,
              adoptedAt: adopted ? new Date(date).toISOString() : null,
              humanMinutes: numeric(minutes),
              humanScope: scope,
              source,
            },
          );
          onSaved(r);
          setMessage('已保存。估算只使用已确认采用且资料完整的样本。');
        } catch (error) {
          setMessage(
            error instanceof Error
              ? error.message
              : '保存失败，请刷新核对结果。',
          );
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field label="业务标识">
        <input
          required
          maxLength={500}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="例如：2026-10 周报"
        />
      </Field>
      <Field label="业务名称">
        <input
          required
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </Field>
      <Field label="业务数量（按所选基准的单位）">
        <input
          required
          type="number"
          min="0.001"
          step="any"
          value={units}
          onChange={(e) => setUnits(e.target.value)}
        />
      </Field>
      <Field label="人工处理基准（固定版本）">
        <select value={baseline} onChange={(e) => setBaseline(e.target.value)}>
          <option value="">未选择，节省工时暂未知</option>
          {baseline && !baselines.some((b) => b.id === baseline) && (
            <option value={baseline}>已保存的历史基准（保持原版本）</option>
          )}
          {baselines.map((b) => (
            <option key={b.id} value={b.id}>
              {b.content.title} · v{b.number}
              {b.content.kind === 'baseline'
                ? ` · ${b.content.minutesPerUnit} 分钟/${b.content.unit}`
                : ''}
            </option>
          ))}
        </select>
      </Field>
      <Field label="实际人工投入（分钟；留空为未知，0 表示确认无人工投入）">
        <input
          type="number"
          min="0"
          step="any"
          value={minutes}
          onChange={(e) => setMinutes(e.target.value)}
        />
      </Field>
      <Field label="投入覆盖">
        <select
          value={scope}
          onChange={(e) =>
            setScope(e.target.value as 'complete' | 'review_only')
          }
        >
          <option value="complete">
            完整流程：准备、复核、返工等全部人工投入
          </option>
          <option value="review_only">仅复核耗时（不计完整收益）</option>
        </select>
      </Field>
      <Field label="业务采用">
        <select
          value={adopted ? 'yes' : 'no'}
          onChange={(e) => setAdopted(e.target.value === 'yes')}
        >
          <option value="no">尚未确认采用</option>
          <option value="yes">确认已采用这个成果版本</option>
        </select>
      </Field>
      {adopted && (
        <Field label="采用时间">
          <input
            required
            type="datetime-local"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </Field>
      )}
      <p>
        本次成果：{props.fileName}。
        {old?.sourceVersionId && old.sourceVersionId !== props.versionId
          ? '保存后将采用版本更新为当前版本，旧修订保留。'
          : ''}
      </p>
      <Field label="采用与人工投入依据">
        <textarea
          required
          rows={3}
          maxLength={500}
          value={source}
          onChange={(e) => setSource(e.target.value)}
          placeholder="说明采用场景和计时依据"
        />
      </Field>
      <Button type="submit" disabled={busy}>
        {busy ? '正在保存…' : '保存登记'}
      </Button>
      {message && <p role="status">{message}</p>}
    </form>
  );
}
