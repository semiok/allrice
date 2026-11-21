export interface EmployeeThreadSelection {
  employeeInstanceId: string;
  threadId: string | null;
}
export interface EmployeeClientRoot {
  openSession(
    nativeSessionId: string,
    signal: AbortSignal,
  ): void | Promise<void>;
  abort(): void | Promise<void>;
  releaseSessionReferences(): void | Promise<void>;
  destroy(): void | Promise<void>;
}
export interface EmployeeClientPort<Mount extends { remountKey: string }> {
  admit(
    selection: EmployeeThreadSelection,
    signal: AbortSignal,
  ): Promise<{ mount: Mount; nativeSessionId: string }>;
  create(mount: Mount, signal: AbortSignal): Promise<EmployeeClientRoot>;
}
export class EmployeeClientNavigation<Mount extends { remountKey: string }> {
  constructor(port: EmployeeClientPort<Mount>);
  select(selection: EmployeeThreadSelection): Promise<'opened' | 'superseded'>;
  dispose(): Promise<void>;
}
