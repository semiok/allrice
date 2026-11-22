export {
  VM_MEMORY_CONTRACT_VERSION,
  VM_PHYSICAL_MEMORY_BYTES,
  VM_MEMORY_PHASE4_REFERENCE_POLICY,
  VmMemoryError,
} from './contract.ts';
export type {
  GuestMemorySample,
  VmMemoryPolicy,
  VmMemoryObservation,
  VmMemorySourceWatch,
  VmMemorySource,
  VmMemoryAdmissionWatch,
  VmMemoryAdmissionPort,
  VmMemoryErrorCode,
} from './contract.ts';
export { createVmMemoryAdmission } from './admission.ts';
export { createVmMemoryGuestPlan } from './guest-config.ts';
export type { VmMemoryGuestPlan } from './guest-config.ts';
