import type { Page } from '../apps/worker/node_modules/playwright-core/index.js';

export interface FailureEvidence {
  mark(phase: string, details?: unknown): void;
  observePage(page: Page): void;
  capture(errors: unknown): Promise<string | undefined>;
  dispose(): void;
}

export function createFailureEvidence(options: {
  file: string;
  test: string;
  collect?: () => unknown | Promise<unknown>;
  root?: string;
}): FailureEvidence;
