// Shared host consumer; Web and Worker use the same c041 lifecycle semantics.
export {
  runDEntryAdmittedActivity,
  type DEntryAdmissionOwner,
  type DEntryAdmissionPorts,
  type DEntryOwnedActivity,
} from '@allrice/database';
