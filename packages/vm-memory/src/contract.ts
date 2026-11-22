import type { PersonVmBinding } from '@allrice/person-vm';

export const VM_MEMORY_CONTRACT_VERSION = 1 as const;
export const VM_PHYSICAL_MEMORY_BYTES = 2048 * 1024 * 1024;

/** Explicit host platform configuration with an approved source, not defaults. */
export type VmMemoryPolicy = Readonly<{
  physicalBytes: number;
  swapBytes: number;
  dshLowBytes: number;
  dshSwapMaxBytes: number;
  commandHighBytes: number;
  commandMaxBytes: number;
  commandSwapMaxBytes: number;
  commandOomGroup: 0;
  dshOomScoreAdj: number;
  commandOomScoreAdj: number;
}>;

/** Historical reference/fixture only. Phase4 authorized an isolated prototype,
 * not platform defaults. Production must explicitly provide approved policy. */
export const VM_MEMORY_PHASE4_REFERENCE_POLICY: VmMemoryPolicy = Object.freeze({
  physicalBytes: VM_PHYSICAL_MEMORY_BYTES,
  swapBytes: 2048 * 1024 * 1024,
  dshLowBytes: 256 * 1024 * 1024,
  dshSwapMaxBytes: 512 * 1024 * 1024,
  commandHighBytes: 768 * 1024 * 1024,
  commandMaxBytes: 1280 * 1024 * 1024,
  commandSwapMaxBytes: 2048 * 1024 * 1024,
  commandOomGroup: 0,
  dshOomScoreAdj: -900,
  commandOomScoreAdj: 800,
});

/** Diagnostic only. Root can change these files; they never grant admission. */
export type GuestMemorySample = Readonly<{
  ramBytes: number | null;
  availableBytes: number | null;
  swapTotalBytes: number | null;
  swapFreeBytes: number | null;
  commandRamBytes: number | null;
  commandSwapBytes: number | null;
  dshRamBytes: number | null;
  dshSwapBytes: number | null;
  commandOomKills: number | null;
  parentLocalOoms: number | null;
  globalOomKills: number | null;
}>;

/** HOST ONLY. A TypeScript shape does not authenticate its producer. The source
 * is injected by trusted VM orchestration, never a guest JSON/header endpoint. */
export type VmMemoryObservation = Readonly<{
  binding: PersonVmBinding;
  revision: string;
  evidenceRef: string;
  /** Produced by external host/provider policy, NOT guest available/memcg data.
   * The provider owns invalidation on disconnect/takeover. No implicit TTL. */
  pressure: 'normal' | 'pressure' | 'unavailable';
  physical: Readonly<{
    configuredBytes: number;
    /** Runtime/provider readback of the hard cap, NOT guest /proc/MemTotal. */
    enforcedBytes: number;
  }>;
  host: Readonly<{
    vmRssBytes: number | null;
    helperRssBytes: number | null;
    swapBytes: number | null;
  }>;
  guest: GuestMemorySample | null;
}>;

export interface VmMemorySourceWatch {
  /** Synchronous current observation; null/unavailable must not mean idle. */
  read(): VmMemoryObservation | null;
  /** Buffered notification: subscribe before read; a prior pulse is retained.
   * A source disconnect/reconnect/invalid observation must also notify. */
  wait(): Promise<void>;
  /** Idempotent; detach, settle any waiter and release owned resources. */
  close(): Promise<void>;
}
export interface VmMemorySource {
  /** Exact host-resolved epoch. Must honor signal, including during watch setup.
   * No polling, thresholds or guest-reported authorization are defined here. */
  watch(
    binding: PersonVmBinding,
    signal: AbortSignal,
  ): Promise<VmMemorySourceWatch>;
}
export interface VmMemoryAdmissionWatch {
  read(): 'ready' | 'queued';
  wait(): Promise<void>;
  close(): Promise<void>;
}
export interface VmMemoryAdmissionPort {
  watch(
    binding: PersonVmBinding,
    signal: AbortSignal,
  ): Promise<VmMemoryAdmissionWatch>;
}
export type VmMemoryErrorCode =
  | 'MEMORY_OBSERVATION_UNAVAILABLE'
  | 'MEMORY_BINDING_INVALID'
  | 'VM_MEMORY_CAP_INVALID';

const messages: Record<VmMemoryErrorCode, string> = {
  MEMORY_OBSERVATION_UNAVAILABLE:
    '内存状态暂不可核实，该次模型尝试未获准发送，会话保留。',
  MEMORY_BINDING_INVALID:
    '内存观察与当前会话实例不一致，该次模型尝试未获准发送，会话保留。',
  VM_MEMORY_CAP_INVALID:
    '虚拟机内存配置未通过核实，该次模型尝试未获准发送，会话保留。',
};
export class VmMemoryError extends Error {
  constructor(
    readonly code: VmMemoryErrorCode,
    options?: ErrorOptions,
  ) {
    super(messages[code], options);
    this.name = 'VmMemoryError';
  }
}
