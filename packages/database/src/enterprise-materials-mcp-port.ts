import {
  ReferenceReadInputSchema,
  ReferenceSelectionErrorSchema,
} from '@allrice/contracts';
import {
  executeEmployeeReferenceTool,
  EmployeeRuntimeContentError,
} from './employees/employee-runtime-content.ts';
import {
  ReferenceRuntimeError,
  ReferenceSelectionUnavailableError,
} from './reference-runtime.ts';
import {
  ReferenceToolResultLimitError,
  ReferenceReadOffsetError,
} from './reference-search.ts';
import { DataAccessError } from './data.ts';
import {
  legacyMcpScope,
  type LegacyMcpExecution,
} from './mcp-legacy-execution.ts';

/** M1 readExact subset of EnterpriseMaterialsPort. This migration factory
 * uses the existing 3.x receipt carrier, not a native 4.0 Run substitute. */
export function createLegacyEnterpriseMaterialsMcpPort() {
  return {
    async readExact(
      authority: LegacyMcpExecution & {
        contentGenerationId: string;
        requestId: string;
      },
      input: unknown,
      signal: AbortSignal,
    ) {
      signal.throwIfAborted();
      try {
        const result = await executeEmployeeReferenceTool(
          legacyMcpScope(authority),
          authority.contentGenerationId,
          authority.worker,
          'workspace.reference.read',
          ReferenceReadInputSchema.parse(input),
          signal,
        );
        signal.throwIfAborted();
        // Exact original bounded text, pin and committed citation ID. The owner
        // records the actual receipt; this adapter creates no additional read.
        return result;
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof ReferenceSelectionUnavailableError) {
          const value = ReferenceSelectionErrorSchema.parse({
            error: {
              code: error.code,
              message: error.message,
              requestId: authority.requestId,
              retryable: false,
              referenceRevisionIds: error.referenceRevisionIds,
            },
          });
          return {
            isError: true as const,
            content: [{ type: 'text' as const, text: JSON.stringify(value) }],
          };
        }
        if (
          error instanceof DataAccessError ||
          error instanceof ReferenceRuntimeError ||
          error instanceof ReferenceToolResultLimitError ||
          error instanceof ReferenceReadOffsetError ||
          error instanceof EmployeeRuntimeContentError
        ) {
          const value =
            error instanceof DataAccessError
              ? {
                  code: 'REFERENCE_UNAVAILABLE',
                  message: '企业资料当前不可读取。',
                  retryable: false,
                }
              : { code: error.code, message: error.message, retryable: false };
          return {
            isError: true as const,
            content: [{ type: 'text' as const, text: JSON.stringify(value) }],
          };
        }
        throw error;
      }
    },
  };
}
