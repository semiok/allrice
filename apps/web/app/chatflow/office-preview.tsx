'use client';

import { useState } from 'react';
import type { OfficePreview as Preview } from '@allrice/contracts';
import styles from './workbench.module.css';

export function OfficePreview({ preview }: { preview: Preview }) {
  const [pageIndex, setPageIndex] = useState(0);
  const page = preview.pages[Math.min(pageIndex, preview.pages.length - 1)]!;
  return (
    <section aria-label="Office 文档预览" className={styles.officePreview}>
      <p>
        已生成页面预览 · 共 {preview.pageCount} 页
        {preview.pages.length < preview.pageCount &&
          ` · 展示前 ${preview.pages.length} 页，完整内容请下载`}
      </p>
      {preview.format === 'xlsx' && (
        <>
          <p role="status">
            已重算 {preview.formulaCount} 个公式
            {preview.formulaErrorCount
              ? ` · 发现 ${preview.formulaErrorCount} 个错误`
              : ' · 未发现公式错误'}
          </p>
          {!!preview.formulas.length && (
            <details>
              <summary>
                查看计算结果
                {preview.formulaCount > preview.formulas.length
                  ? `（前 ${preview.formulas.length} 项，错误优先）`
                  : ''}
              </summary>
              <div className={styles.officeResults}>
                <table>
                  <thead>
                    <tr>
                      <th>单元格</th>
                      <th>公式</th>
                      <th>本次重算结果</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.formulas.map((f) => (
                      <tr key={`${f.sheet}!${f.cell}`}>
                        <td>
                          {f.sheet}!{f.cell}
                        </td>
                        <td>{f.formula || '共享公式'}</td>
                        <td>{String(f.value)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
          <p className={styles.muted}>
            计算检查不代替业务核对。时间、随机函数在重新计算时可能与文件保存值不同。
          </p>
        </>
      )}
      <div className={styles.actions}>
        <button
          type="button"
          disabled={page.number === 1}
          onClick={() => setPageIndex(page.number - 2)}
        >
          上一页
        </button>
        <span aria-live="polite">
          第 {page.number} / {preview.pageCount} 页
        </span>
        <button
          type="button"
          disabled={page.number === preview.pages.length}
          onClick={() => setPageIndex(page.number)}
        >
          下一页
        </button>
      </div>
      <img
        alt={`Office 文档第 ${page.number} 页`}
        src={`data:image/png;base64,${page.base64}`}
      />
      <p className={styles.muted}>
        请检查分页、文字和图表是否完整。预览排版可能与本机 Office
        有差异，完整文件可下载编辑。
      </p>
    </section>
  );
}
