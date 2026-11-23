import { MemoryOrdinalInputSchema } from '@allrice/contracts';
import {
  readRunMemoryOrdinal,
  MemoryContextError,
} from './run-memory-context.ts';
import { DataAccessError } from './data.ts';
import {
  legacyMcpScope,
  legacyMcpAccessError,
  type LegacyMcpExecution,
} from './mcp-legacy-execution.ts';

/** M1 readOrdinal subset of EmployeeMemoryPort. Issued pins and UTF-8 budgets
 * remain on the real owner ledger. No arbitrary detail lookup or new budget. */
export function createLegacyEmployeeMemoryMcpPort() {
  return {
    async readOrdinal(
      authority: LegacyMcpExecution & { requestId: string },
      input: unknown,
      signal: AbortSignal,
    ) {
      signal.throwIfAborted();
      try {
        const text = await readRunMemoryOrdinal(
          { scope: legacyMcpScope(authority), worker: authority.worker },
          MemoryOrdinalInputSchema.parse(input),
        );
        // The existing transaction is awaited, not abandoned on disconnect.
        // Cancellation can hide a result, never erase committed tool spend.
        signal.throwIfAborted();
        return text;
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof DataAccessError)
          return legacyMcpAccessError(authority.requestId, error);
        if (error instanceof MemoryContextError)
          return {
            isError: true as const,
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  code: error.code,
                  message: error.message,
                  retryable: false,
                }),
              },
            ],
          };
        throw error;
      }
    },
  };
}
