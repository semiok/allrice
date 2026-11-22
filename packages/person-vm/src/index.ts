export * from './contract.ts';
export type {
  PersonVmWebRoster,
  PersonVmWebEndpointReceipt,
  PersonVmWebStartup,
  PersonVmWebRosterPort,
} from './web-endpoints.ts';
export type {
  PersonVmMemoryGuestPlan,
  PersonVmGuestCommand,
  PersonVmJobExit,
  PersonVmManagedJob,
  PersonVmStartingScope,
  PersonVmBootstrapScope,
  PersonVmGuestBootstrapPort,
} from './guest-bootstrap.ts';
export * from './admission-contract.ts';
export {
  nativeWebAuthArtifact,
  type PersonVmNativeWebAuth,
  type PersonVmNativeWebAuthRequest,
} from './native-web-auth.ts';
export * from './admission-boundary.ts';
export { PersonVmAdmissionHost } from './admission-host.ts';
export { PersonVmService, sameVmBinding } from './person-vm.ts';
export {
  PostgresPersonVmStore,
  type PersonVmStore,
  type PersonVmSqlFactory,
  type VmHold,
  type PersonVmLeaseOwner,
  type PersonVmLeaseFencePort,
} from './store.ts';
export {
  MicrosandboxPersonVm,
  type PersonVmNativePort,
} from './microsandbox.ts';
export {
  ApfsPersonVmDisk,
  FilePersonVmKeyStore,
  type PersonVmDiskPort,
  type PersonVmKeyStore,
  type PersonDisk,
  type PersonVmDiskInspection,
} from './encrypted-disk.ts';

export type {
  PersonVmNativeResourceFacts,
  PersonVmNativeResourcePort,
  PersonVmNativeResourceSubscription,
  PersonVmResourceLiveness,
  PersonVmResourceLifecycleWatch,
  PersonVmResourceLifecyclePort,
  PersonVmResourceWatch,
  PersonVmResourcePort,
} from './resource-contract.ts';
export { createPersonVmResourcePort } from './resource-watch.ts';

export {
  createPersonVmCommandMemoryObserver,
  PERSON_VM_COMMAND_MEMORY_PROGRAM,
} from './native-command-observer.ts';
export type {
  PersonVmManagedProbeJob,
  PersonVmManagedProbePort,
  PersonVmNativeCommandExecution,
  PersonVmCommandMemoryCompletion,
} from './native-command-observer.ts';

export {
  createPersonVmGuestMemoryReader,
  PERSON_VM_GUEST_CONTROL_READER,
} from './native-resource.ts';
export type {
  PersonVmGuestControlValue,
  PersonVmGuestControlTarget,
  PersonVmGuestControlReadback,
  PersonVmGuestMemoryReadback,
} from './native-resource.ts';
