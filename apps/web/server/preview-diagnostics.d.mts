import type { IncomingMessage, ServerResponse } from 'node:http';

export interface PreviewDiagnosticDetails {
  durationMs?: number;
  status?: number;
  aborted?: boolean;
  outcome?: string;
}

export interface PreviewDiagnostics {
  requestId: string;
  started: number;
  emit(
    event: string,
    stage: string,
    details?: PreviewDiagnosticDetails,
    error?: unknown,
    referenceId?: string,
  ): void;
  object(id: string): void;
  phase<T>(stage: string, body: () => T | PromiseLike<T>): Promise<T>;
}

export function createPreviewDiagnostics(): PreviewDiagnostics;
export function activePreviewDiagnostics(): PreviewDiagnostics | undefined;
export function observePreviewHttp<T>(
  request: IncomingMessage,
  response: ServerResponse,
  handle: () => T,
): T;
