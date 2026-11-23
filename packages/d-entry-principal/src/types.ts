import { z } from 'zod';
import { DEntryIdentitySchema, UuidSchema } from '@allrice/contracts';
import type { Context } from '@deepseek-ai/cordis';
import type { DEntryIdentity } from '@allrice/contracts';
import type { RemoteAccessBaseline } from '@deepseek-ai/dsh-api-remote-access';
import type { TYPERT_REMOTE as Native } from '@deepseek-ai/dsh-api-session-controller/remote';
import type { TYPERT_REMOTE as Access } from '@deepseek-ai/dsh-api-remote-access/remote';
import type {
  RemoteEventDownlinkFrame,
  REMOTE_EVENT_STREAM_PAYLOAD,
} from '@deepseek-ai/dsh-api-gateway/stream-protocol';
import type {
  PrincipalMap,
  TypertRemoteInputOptions,
  TypertRemoteValue,
} from '@deepseek-ai/dsh-typert-protocol';

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    'allrice-d-entry': Readonly<{
      kind: 'allrice-d-entry';
      scopeId: string;
      identity: DEntryIdentity;
    }>;
  }
}
export type DEntryPrincipal = PrincipalMap['allrice-d-entry'];
export type DEntryPrincipalIssue = Readonly<{
  scopeId: string;
  identity: DEntryIdentity;
  access: 'history' | 'execute';
  root: Readonly<{
    nativeSessionId: string;
    rootOriginDigest: string;
    rootBindingRef: string;
  }>;
}>;
export type CloseCommand = 'close';
export type NonOwnerBaseline = Extract<RemoteAccessBaseline, { owner: false }>;
export type ScopeFrame =
  | Readonly<{
      type: 'opened';
      scopeId: string;
      principal: DEntryPrincipal;
      baseline: NonOwnerBaseline;
    }>
  | Readonly<{ type: 'closed'; scopeId: string }>;
export type InputOf<M> = M extends {
  input(options?: TypertRemoteInputOptions): TypertRemoteValue<infer I>;
}
  ? I
  : never;
export type OutputOf<M> = M extends { result: TypertRemoteValue<infer O> }
  ? O
  : never;
type NativeMethods = typeof Native.methods;
type AccessMethods = typeof Access.methods;
export type NativeUnary =
  | 'session/attachment'
  | 'session/page'
  | 'session/projections'
  | 'skills/list'
  | 'session/prompt'
  | 'session/updateQueue'
  | 'session/cancel'
  | 'session/rename'
  | 'session/selectModel';
type Calls<K extends keyof NativeMethods> = {
  [E in K]: Readonly<{
    scopeId: string;
    endpoint: E;
    args: InputOf<NativeMethods[E]>;
  }>;
}[K];
export type DEntryScopedUnaryCall = Calls<NativeUnary>;
export type DEntryScopedUnaryResult = {
  [E in NativeUnary]: Readonly<{
    endpoint: E;
    value: OutputOf<NativeMethods[E]>;
  }>;
}[NativeUnary];
export type DEntryScopedStreamCall =
  | Calls<'session/follow'>
  | Readonly<{
      scopeId: string;
      endpoint: 'remoteAccess/follow';
      args: InputOf<AccessMethods['remoteAccess/follow']>;
    }>
  | Readonly<{
      kind: 'events';
      scopeId: string;
      payload: typeof REMOTE_EVENT_STREAM_PAYLOAD;
    }>;
export type DEntryScopedStreamFrame =
  | Readonly<{ type: 'closed'; scopeId: string }>
  | Readonly<{
      type: 'item';
      scopeId: string;
      value:
        | OutputOf<NativeMethods['session/follow']>
        | OutputOf<AccessMethods['remoteAccess/follow']>
        | Extract<RemoteEventDownlinkFrame, { type: 'ready' | 'emit' }>;
    }>;
export interface DEntryPrincipalControlScope {
  readonly opened: Extract<ScopeFrame, { type: 'opened' }>;
  readonly revoked: AbortSignal;
  invoke(
    call: DEntryScopedUnaryCall,
    signal: AbortSignal,
  ): Promise<DEntryScopedUnaryResult>;
  stream(
    call: DEntryScopedStreamCall,
    signal: AbortSignal,
  ): AsyncIterable<DEntryScopedStreamFrame & { type: 'item' }>;
  close(): Promise<void>;
}
export interface DEntryPrincipalActivity {
  run(signal: AbortSignal): Promise<DEntryPrincipalControlScope>;
  close(): Promise<void>;
}
export type PrincipalClientContext = Context;

export const DEntryPrincipalIssueSchema = z
  .object({
    scopeId: UuidSchema,
    identity: DEntryIdentitySchema,
    access: z.enum(['history', 'execute']),
    root: z
      .object({
        nativeSessionId: z.string().min(1),
        rootOriginDigest: z.string().min(1),
        rootBindingRef: z.string().min(1),
      })
      .strict(),
  })
  .strict();
