'use client';
import { useEffect, useMemo, useState, type ComponentType } from 'react';
import {
  documentPreviewLimits,
  type SpreadsheetFormat,
} from '../../lib/chatflow/document-preview-policy';
import {
  loadNativeDocumentModule,
  previewBytes,
  previewLocale,
} from './native-document-module';
import { zh } from './dsh-upstream/document/excel/locales';
import { LoadingIndicator } from './dsh-upstream/document/LoadingIndicator';
import styles from './document-reader.module.css';
const t = previewLocale(zh);
type Props = {
  content: { kind: 'bytes'; data: Uint8Array<ArrayBuffer> };
  format: SpreadsheetFormat;
  limits: typeof documentPreviewLimits.excel;
  t: typeof t;
};
type ExcelModule = { ExcelBody: ComponentType<Props> };
export function NativeExcelPreview({
  base64,
  format,
}: {
  base64: string;
  format: SpreadsheetFormat;
}) {
  const data = useMemo(() => previewBytes(base64), [base64]);
  const [module, setModule] = useState<ExcelModule>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setError('');
    void loadNativeDocumentModule<ExcelModule>('excel').then(
      (value) => {
        if (active) setModule(value);
      },
      () => {
        if (active) setError('表格预览组件加载失败');
      },
    );
    return () => {
      active = false;
    };
  }, [attempt]);
  if (error)
    return (
      <div role="alert">
        {error}
        <button type="button" onClick={() => setAttempt((v) => v + 1)}>
          重新加载
        </button>
      </div>
    );
  if (!module) return <LoadingIndicator label={zh.loading} />;
  return (
    <div className={styles.nativeContent}>
      <module.ExcelBody
        content={{ kind: 'bytes', data }}
        format={format}
        limits={documentPreviewLimits.excel}
        t={t}
      />
    </div>
  );
}
