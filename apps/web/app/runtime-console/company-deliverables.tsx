'use client';
import { useEffect, useState } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import {
  CompanyDeliverableEvidenceSchema,
  type CompanyDeliverableEvidence,
  type CompanyDeliverable,
  type CompanyDeliverables,
} from '@allrice/contracts';
import { useActivityPages } from './organization-activity-data';
import { DshDialog } from '../chatflow/dsh-upstream/Dialog';
import { NativeDocumentPreview } from '../chatflow/native-document-preview';
import { FontNotice } from '../chatflow/dsh-upstream/document/office/FontNotice';
import { zh as officeZh } from '../chatflow/dsh-upstream/document/office/locales';
import {
  parseArtifactPreview,
  workbenchJson,
  type ArtifactPreview,
} from '../../lib/chatflow/workbench-model';
import { TenantValidation } from './tenant-validation';
import styles from './tenant-administration.module.css';
const stateLabels = {
  ready: '可用',
  expired: '已过期',
  deleted: '已删除',
  unavailable: '暂不可用',
};
export function CompanyDeliverableLibrary({
  organizationId,
  scopeQuery,
}: {
  organizationId: string;
  scopeQuery: string;
}) {
  const [format, setFormat] = useState(''),
    [includeUnavailable, setUnavailable] = useState(false),
    [periodOnly, setPeriodOnly] = useState(false);
  const [selected, setSelected] = useState<CompanyDeliverable | null>(null),
    [work, setWork] = useState<CompanyDeliverable | null>(null);
  const base = `/api/v1/admin/organizations/${organizationId}/deliverables`;
  const page = useActivityPages<CompanyDeliverables>(
    `${base}?${scopeQuery}&includeUnavailable=${includeUnavailable ? '1' : '0'}&periodOnly=${periodOnly ? '1' : '0'}${format ? '&format=' + format : ''}`,
    'deliverables',
    'before',
  );
  useEffect(() => {
    setSelected(null);
    setWork(null);
  }, [organizationId, scopeQuery]);
  return (
    <section className={styles.editor} aria-label="公司交付成果">
      <h3>公司交付成果</h3>
      <p>
        每项成果显示最新可用版本。预览固定所选版本，原始文件不因刷新或他人修改而替换。
      </p>
      <div className={styles.selectors}>
        <label>
          文件类型
          <select
            aria-label="成果文件类型"
            value={format}
            onChange={(e) => setFormat(e.target.value)}
          >
            <option value="">全部类型</option>
            {[
              'docx',
              'xlsx',
              'pptx',
              'pdf',
              'png',
              'html',
              'markdown',
              'text',
              'json',
            ].map((f) => (
              <option key={f} value={f}>
                {f.toUpperCase()}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={periodOnly}
            onChange={(e) => setPeriodOnly(e.target.checked)}
          />
          只看本期更新
        </label>
        <label>
          <input
            type="checkbox"
            checked={includeUnavailable}
            onChange={(e) => setUnavailable(e.target.checked)}
          />
          显示不可用成果
        </label>
        <Button disabled={page.loading} onClick={() => void page.load()}>
          刷新成果列表
        </Button>
      </div>
      {page.error && <p role="alert">{page.error}</p>}
      <div className={styles.table}>
        <table>
          <thead>
            <tr>
              <th>成果</th>
              <th>员工 / AI 员工</th>
              <th>来源工作</th>
              <th>更新时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {page.data?.deliverables.map((row) => (
              <tr key={row.seriesId}>
                <td>
                  <strong>{row.fileName}</strong>
                  <small>
                    {row.format.toUpperCase()} · v{row.version} ·{' '}
                    {stateLabels[row.state]}
                    {row.latestPublishedVersion > row.version
                      ? ` · 更新版本 v${row.latestPublishedVersion} 不可用`
                      : ''}
                  </small>
                </td>
                <td>
                  {row.ownerName}
                  <small>{row.employeeName ?? '历史成果未记录 AI 员工'}</small>
                </td>
                <td>
                  {row.sessionTitle}
                  <small>{row.runId ? '已有来源轮次' : '来源轮次未记录'}</small>
                  {row.runStatus && row.runStatus !== 'succeeded' && (
                    <small>
                      {row.runStatus === 'failed'
                        ? '工作失败，保留部分成果'
                        : row.runStatus === 'canceled'
                          ? '工作已取消，保留部分成果'
                          : '工作尚未完成'}
                    </small>
                  )}
                </td>
                <td>{new Date(row.createdAt).toLocaleString()}</td>
                <td>
                  <Button
                    aria-haspopup="dialog"
                    onClick={() => setSelected(row)}
                  >
                    查看成果
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!page.data && page.loading && <p role="status">正在读取成果…</p>}
      {page.data && !page.data.deliverables.length && (
        <p>还没有匹配的交付成果。文件上传和工具日志不计入这里。</p>
      )}
      {page.data?.nextCursor && (
        <Button disabled={page.loading} onClick={() => void page.load(true)}>
          更多成果
        </Button>
      )}
      {selected && (
        <DshDialog
          ariaLabel="公司成果预览"
          title={selected.fileName}
          eyebrow={`${selected.ownerName} · ${selected.employeeName ?? '历史来源未完整记录'}`}
          className={`${styles.panel} ${styles.workDialog}`}
          bodyClassName={styles.workDialogBody}
          onClose={() => setSelected(null)}
        >
          <CompanyFilePreview
            organizationId={organizationId}
            initial={selected}
            onSource={(row) => {
              setSelected(null);
              setWork(row);
            }}
          />
        </DshDialog>
      )}
      {work?.runId && (
        <DshDialog
          ariaLabel="成果来源工作"
          title={work.sessionTitle}
          eyebrow={`${work.ownerName} · ${work.employeeName}`}
          className={`${styles.panel} ${styles.workDialog}`}
          bodyClassName={styles.workDialogBody}
          onClose={() => setWork(null)}
        >
          <TenantValidation
            organizationId={organizationId}
            workspaceId={work.workspaceId}
            subjectId={work.ownerId}
            initialRunId={work.runId}
            onDirty={() => undefined}
            onBusy={() => undefined}
          />
        </DshDialog>
      )}
    </section>
  );
}
function CompanyFilePreview({
  organizationId,
  initial,
  onSource,
}: {
  organizationId: string;
  initial: CompanyDeliverable;
  onSource: (row: CompanyDeliverable) => void;
}) {
  const [selected, setSelected] = useState(initial),
    [preview, setPreview] = useState<ArtifactPreview | null>(null),
    [evidence, setEvidence] = useState<CompanyDeliverableEvidence | null>(null),
    [evidenceError, setEvidenceError] = useState(''),
    [error, setError] = useState('');
  const base = `/api/v1/admin/organizations/${organizationId}/deliverables`;
  const history = useActivityPages<CompanyDeliverables>(
    `${base}?seriesId=${initial.seriesId}&includeUnavailable=1`,
    'deliverables',
    'before',
  );
  const url = `${base}?artifactId=${selected.id}`;
  useEffect(() => {
    setPreview(null);
    setError('');
    setEvidence(null);
    setEvidenceError('');
    if (selected.state !== 'ready') return;
    const controller = new AbortController();
    void workbenchJson(`${url}&metadata=1`, {}, { signal: controller.signal })
      .then((body) => {
        if (!controller.signal.aborted)
          setEvidence(CompanyDeliverableEvidenceSchema.parse(body));
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setEvidenceError(e instanceof Error ? e.message : '来源记录暂不可用');
      });
    void workbenchJson(url, {}, { signal: controller.signal })
      .then((body) => {
        if (!controller.signal.aborted) setPreview(parseArtifactPreview(body));
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : '读取失败');
      });
    return () => controller.abort();
  }, [url, selected.state]);
  return (
    <section aria-label="固定版本成果预览">
      <div className={styles.selectors}>
        <label>
          成果版本
          <select
            aria-label="成果版本"
            value={selected.id}
            onChange={(e) => {
              const row = history.data?.deliverables.find(
                (r) => r.id === e.target.value,
              );
              if (row) {
                setPreview(null);
                setError('');
                setEvidence(null);
                setEvidenceError('');
                setSelected(row);
              }
            }}
          >
            {!history.data?.deliverables.some((r) => r.id === selected.id) && (
              <option value={selected.id}>
                v{selected.version} · {stateLabels[selected.state]}
              </option>
            )}
            {history.data?.deliverables.map((r) => (
              <option key={r.id} value={r.id}>
                v{r.version} · {stateLabels[r.state]} ·{' '}
                {new Date(r.createdAt).toLocaleString()}
              </option>
            ))}
          </select>
        </label>
        {history.data?.nextCursor && (
          <Button
            disabled={history.loading}
            onClick={() => void history.load(true)}
          >
            更早版本
          </Button>
        )}
        {selected.state === 'ready' && (
          <a href={`${url}&download=1`}>下载原文件</a>
        )}
        {selected.runId && (
          <Button onClick={() => onSource(selected)}>查看来源工作</Button>
        )}
      </div>
      {history.error && <p role="alert">{history.error}</p>}
      {selected.state === 'ready' && (
        <details>
          <summary>文件来源与质量</summary>
          {evidenceError && <p role="alert">{evidenceError}</p>}
          {!evidence && !evidenceError && (
            <p role="status">正在读取来源记录…</p>
          )}
          {evidence && (
            <>
              <p>
                原文件校验值：<code>{evidence.checksum}</code>
              </p>
              <p>
                原文件编号：<code>{evidence.objectId}</code>
              </p>
              {evidence.sourceFile ? (
                <p>
                  参考源文件：<code>{evidence.sourceFile.objectId}</code> ·{' '}
                  <code>{evidence.sourceFile.checksum}</code>
                </p>
              ) : (
                <p>未记录参考源文件。</p>
              )}
              {evidence.office?.quality.status === 'checked' ? (
                <p>
                  Office 检查：已生成 {evidence.office.quality.pageCount}{' '}
                  页预览，{evidence.office.quality.formulaCount} 个公式，其中{' '}
                  {evidence.office.quality.formulaErrorCount}{' '}
                  个错误。排版未经人工审查，计算结果不代替业务核对。
                </p>
              ) : evidence.office?.quality.status === 'unavailable' ? (
                <p>Office 检查暂不可用：{evidence.office.quality.reason}</p>
              ) : (
                <p>未记录 Office 检查结果。</p>
              )}
              {evidence.office?.warnings.map((warning, index) => (
                <p key={index}>{warning}</p>
              ))}
            </>
          )}
        </details>
      )}
      <FontNotice
        key={selected.id}
        fonts={preview?.kind === 'pdf' ? (preview.missingFonts ?? []) : []}
        t={(key, params) =>
          Object.entries(params ?? {}).reduce(
            (s, [name, value]) => s.replaceAll(`{${name}}`, String(value)),
            officeZh[key] as string,
          )
        }
      />
      {selected.runId === null && (
        <p>
          这是历史成果，尚未记录来源轮次。原文件仍按公司、员工和会话核对权限。
        </p>
      )}
      {selected.state !== 'ready' && (
        <p>
          {stateLabels[selected.state]}
          ，当前版本无法预览或下载；可选择仍可用的历史版本。
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {selected.state === 'ready' && !preview && !error && (
        <p role="status">正在读取成果…</p>
      )}
      {preview && (
        <NativeDocumentPreview
          key={selected.id}
          preview={preview}
          fileName={selected.fileName}
          pageUrl={url}
        />
      )}
    </section>
  );
}
