import {
  ApiErrorSchema,
  DeliverableReadMcpProjectionSchema,
  type DeliverablesPort,
  type RequestContext,
} from '@allrice/contracts';
import { DataAccessError } from './data.ts';
import { DeliverableReadError } from './deliverables-port.ts';

const accessCodes = {
  authentication_required: 'AUTHENTICATION_REQUIRED',
  authorization_denied: 'AUTHORIZATION_DENIED',
  not_found: 'RESOURCE_NOT_FOUND',
  quota_exceeded: 'QUOTA_EXCEEDED',
  grant_invalid: 'SIGNED_ACCESS_DENIED',
} as const;

/** Stateless business adapter, not an authority or an MCP server. The supplied
 * owner still requires trusted current qualification and live resource access.
 * Its Promise includes the real read and stream cleanup; never detach it. */
export function createDeliverablesMcpReadPort(
  owner: Pick<DeliverablesPort, 'readExact'>,
) {
  return {
    async readExact(
      context: RequestContext,
      input: Parameters<DeliverablesPort['readExact']>[1],
      signal: AbortSignal,
    ) {
      signal.throwIfAborted();
      try {
        const result = DeliverableReadMcpProjectionSchema.parse(
          await owner.readExact(context, input, signal),
        );
        signal.throwIfAborted();
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        // In particular, preserve the owner's AggregateError if native abort
        // and stream cleanup both failed. Cancellation must not become isError.
        if (signal.aborted) throw error;
        if (error instanceof DataAccessError) {
          const value = ApiErrorSchema.parse({
            error: {
              code: accessCodes[error.code],
              message: error.message,
              requestId: context.requestId,
              retryable: false,
            },
          });
          return {
            isError: true as const,
            content: [{ type: 'text' as const, text: JSON.stringify(value) }],
          };
        }
        if (error instanceof DeliverableReadError)
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
        // The server owns protocol redaction for unknown failures.
        throw error;
      }
    },
  };
}
