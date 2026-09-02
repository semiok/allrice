'use client';

import type { EmployeeProfile } from './chatflow-types';
import { DshDialog } from './dsh-upstream/Dialog';
import styles from './dsh-saas.module.css';
import { EmployeeProfileDetails } from './employee-profile-details';

interface EmployeeDetailsDialogProps {
  open: boolean;
  profile: EmployeeProfile | null;
  onClose: () => void;
}

export function EmployeeDetailsDialog({
  open,
  profile,
  onClose,
}: EmployeeDetailsDialogProps) {
  if (!open || !profile) return null;

  return (
    <DshDialog
      ariaLabel={`${profile.name}员工详情`}
      bodyClassName={styles.employeeDetailsBody}
      className={styles.employeeDetailsDialog}
      eyebrow="AI 员工 · 租户只读"
      onClose={onClose}
      title={profile.name}
    >
      <EmployeeProfileDetails profile={profile} />
    </DshDialog>
  );
}
