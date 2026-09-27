'use client';

import { NativeImagePages } from './native-image-preview';
import type { OfficePreview as Preview } from '@allrice/contracts';
import styles from './workbench.module.css';

export function OfficePreview({ preview }: { preview: Preview }) {
  return (
    <section aria-label="Office 文档预览" className={styles.officePreview}>
      {preview.pages.length < preview.pageCount && (
        <p className={styles.previewNotice} role="status">
          展示前 {preview.pages.length} 页，共 {preview.pageCount}{' '}
          页；完整内容请下载。
        </p>
      )}
      {preview.format === 'xlsx' &&
        (preview.formulaCount > 0 || preview.formulaErrorCount > 0) && (
          <details className={styles.officeDetails}>
            <summary>
              {preview.formulaErrorCount
                ? `发现 ${preview.formulaErrorCount} 个公式错误 · 查看详情`
                : '计算详情'}
            </summary>
            <p>
              已重算 {preview.formulaCount}{' '}
              个公式。计算结果可能因时间、随机函数与文件保存值不同。
            </p>
            {!!preview.formulas.length && (
              <>
                {preview.formulaCount > preview.formulas.length && (
                  <p>展示前 {preview.formulas.length} 项，错误优先。</p>
                )}
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
              </>
            )}
          </details>
        )}
      <NativeImagePages
        paper
        images={preview.pages.map((page) => ({
          alt: `Office 文档第 ${page.number} 页`,
          src: `data:image/png;base64,${page.base64}`,
        }))}
      />
    </section>
  );
}
