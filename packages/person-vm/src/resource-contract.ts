import type { RequestContext } from '@allrice/contracts';
import type { PersonVmBinding } from './contract.ts';

/** Host facts only. The type does not authenticate a native producer. */
export type PersonVmNativeResourceFacts = Readonly<{
  binding: PersonVmBinding;
  /** Must equal the native resource subscription's current revision. */
  revision: string;
  evidenceRef: string;
  physical:
    | Readonly<{
        state: 'verified';
        configuredBytes: number;
        enforcedBytes: number;
        sourceRef: string;
      }>
    | Readonly<{
        state: 'unknown';
        configuredBytes: number;
        reason: string;
      }>;
  host: Readonly<{
    vmRssBytes: number | null;
    helperRssBytes: number | null;
    swapBytes: number | null;
  }>;
}>;

/** Independent resource changes, NOT a lifecycle/admission cursor. */
export interface PersonVmNativeResourceSubscription {
  /** Null immediately on disconnect, loss of identity or an observation gap. */
  read(): string | null;
  /** Buffered notification, including invalidation and reconnect. */
  wait(): Promise<void>;
  /** Detach, settle wait and join owned work, including on cancellation. */
  close(): Promise<void>;
}

export interface PersonVmNativeResourcePort {
  /** Subscribe before read. The owner supplies the actual resource event source;
   * no sampling interval, fallback configuration or identity is invented here. */
  subscribe(
    binding: PersonVmBinding,
    signal: AbortSignal,
  ): Promise<PersonVmNativeResourceSubscription>;
  read(
    binding: PersonVmBinding,
    signal: AbortSignal,
  ): Promise<PersonVmNativeResourceFacts>;
}

export type PersonVmResourceLiveness = Readonly<{
  binding: PersonVmBinding;
  revision: string;
  evidenceRef: string;
}>;

export interface PersonVmResourceLifecycleWatch {
  /** Current server authority, exact instance/epoch and native liveness. Null
   * before stop/delete/failure/takeover, revocation, exit or disconnect proceeds. */
  read(): PersonVmResourceLiveness | null;
  /** Buffered notification; a lifecycle revision does not imply resource change. */
  wait(): Promise<void>;
  close(): Promise<void>;
}

export interface PersonVmResourceLifecyclePort {
  /** The trusted owner rechecks current authority for every subscription. */
  watch(
    context: RequestContext,
    binding: PersonVmBinding,
    signal: AbortSignal,
  ): Promise<PersonVmResourceLifecycleWatch>;
}

export interface PersonVmResourceWatch {
  read(): PersonVmNativeResourceFacts | null;
  /** Notification is not readiness or a lasting permit. */
  wait(): Promise<void>;
  /** Invalidate synchronously; cancel and join all owned I/O/subscriptions. */
  close(): Promise<void>;
}

export interface PersonVmResourcePort {
  watch(
    context: RequestContext,
    binding: PersonVmBinding,
    signal: AbortSignal,
  ): Promise<PersonVmResourceWatch>;
}
