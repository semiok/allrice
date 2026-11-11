import { Fragment, type ReactNode } from 'react';
import type { WorkbenchArtifact } from '@allrice/contracts';
import type { WorkProcessReference } from '../../lib/chatflow/work-progress';
import styles from './dsh-saas.module.css';

/** Authorized display facts, never an execution or approval authority. */
export interface WorkProcessMaterial extends WorkProcessReference {
  fields: readonly { label: string; value: ReactNode }[];
}

export interface WorkProcessMaterialFeed {
  history: readonly WorkProcessMaterial[];
  interaction: ReactNode;
  feedback: ReactNode;
}

/** Read-only fields inside the existing native step, without a second title. */
export function ProcessMaterialFields({
  material,
  artifacts = [],
}: {
  material: WorkProcessMaterial;
  artifacts?: readonly WorkbenchArtifact[];
}) {
  const fields = [
    { label: '状态', value: material.status },
    ...material.fields,
  ];
  return (
    <div
      id={`process-material-${material.source}-${material.id}`}
      data-process-operation={material.id}
      data-process-source={material.source}
      data-process-material={`${material.source}:${material.id}`}
    >
      <dl
        className={styles.processDetailGrid}
        data-process-operation={`${material.source}:${material.id}`}
      >
        {fields.map((field) => (
          <Fragment key={field.label}>
            <dt>{field.label}</dt>
            <dd
              data-process-content={`material:${material.source}:${material.id}:${field.label}`}
            >
              {field.value}
            </dd>
          </Fragment>
        ))}
        {artifacts.map((artifact) => (
          <Fragment key={artifact.id}>
            <dt>成果</dt>
            <dd data-process-artifact={artifact.id}>
              {artifact.version.fileName} · 版本 {artifact.version.version}
            </dd>
          </Fragment>
        ))}
      </dl>
    </div>
  );
}

/** The same authorized fields in place, without another disclosure or reader. */
export function InlineProcessFields({
  rows = [],
  children,
}: {
  rows?: readonly (readonly [string, ReactNode])[];
  children?: ReactNode;
}) {
  return (
    <div className={styles.processStepDetails}>
      {rows.length > 0 && (
        <dl className={styles.processDetailGrid}>
          {rows.map(([label, value], index) => (
            <Fragment key={`${label}:${index}`}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </Fragment>
          ))}
        </dl>
      )}
      {children}
    </div>
  );
}
