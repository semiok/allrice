import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import {
  ApiErrorSchema,
  ExecutionGenerationSchema,
  MemoryOrdinalInputSchema,
  NativeOfficeExportSchema,
  OfficePdfExportSchema,
  ReferenceReadInputSchema,
  ReferenceSelectionErrorSchema,
  RequestContextSchema,
  UuidSchema,
  type DeliveryFormat,
  type ExecutionGeneration,
  type ReferenceReadInput,
  type RequestContext,
} from '@allrice/contracts';
import { z } from 'zod';
import { riceToolDefinitions } from '../tool-broker/definitions.js';

export interface AllriceMcpBinding {
  personId: string;
  organizationId: string;
  workspaceId: string | null;
  employeeInstanceId: string;
  allriceThreadRef: string;
  nativeSessionRef: {
    instanceId: string;
    profileId: string;
    sessionId: string;
  };
  executionGeneration: ExecutionGeneration;
}
export type AllriceMcpModule =
  'enterprise-materials' | 'employee-memory' | 'deliverables';
export interface AllriceMcpScope extends AllriceMcpBinding {
  requestContext: RequestContext;
  /** Current VM-external qualification, never reconstructed from arguments. */
  enabledModules: readonly AllriceMcpModule[];
  moduleConfigRevisionRef: string;
  /** Host/native-call association. The wire request ID is not an authority. */
  nativeCallRef: string | null;
}
export interface AllriceMcpHost {
  readonly binding: AllriceMcpBinding;
  /** Authenticated gateway supplies current scope. requestId/toolName are only
   * untrusted correlation/selectors, never person/tenant/approval inputs. */
  current(
    request: { requestId: string | number; toolName: string | null },
    signal: AbortSignal,
  ): Promise<AllriceMcpScope>;
}
/** Exact existing workspace.export.create business input. Its JSON Schema is
 * reused below; host-only prepared bytes/stamps/lease never enter this type. */
export interface AllriceMcpDeliverableInput {
  fileName: string;
  format: Extract<
    DeliveryFormat,
    'markdown' | 'text' | 'html' | 'json' | 'docx' | 'xlsx' | 'pptx' | 'pdf'
  >;
  artifactKind?: 'document' | 'plan' | 'changeset';
  content?: string;
  python?: z.input<typeof NativeOfficeExportSchema>;
  officePdf?: z.input<typeof OfficePdfExportSchema>;
  location?: 'auto' | 'local' | 'cloud';
  parentObjectId?: string;
  changeSummary?: string;
}
export interface AllriceMcpServices {
  readonly executionGeneration: ExecutionGeneration;
  referenceRead?(
    scope: AllriceMcpScope,
    input: ReferenceReadInput,
    signal: AbortSignal,
  ): Promise<CallToolResult>;
  memoryRead?(
    scope: AllriceMcpScope,
    input: { number: number },
    signal: AbortSignal,
  ): Promise<CallToolResult>;
  deliverableCreate?(
    scope: AllriceMcpScope,
    input: AllriceMcpDeliverableInput,
    signal: AbortSignal,
  ): Promise<CallToolResult>;
}

const deliverySchema = riceToolDefinitions.find(
  (tool) => tool.name === 'workspace.export.create',
)!.inputSchema;
const validateDelivery =
  new AjvJsonSchemaValidator().getValidator<AllriceMcpDeliverableInput>(
    deliverySchema,
  );
const tools: Tool[] = [
  {
    name: 'identity_read',
    description: 'Read the current non-secret AllRice identity display.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'reference_read',
    description: 'Read an authorized exact enterprise-material revision.',
    inputSchema: z.toJSONSchema(ReferenceReadInputSchema, {
      io: 'input',
    }) as Tool['inputSchema'],
    annotations: { readOnlyHint: true },
  },
  {
    name: 'memory_read',
    description: 'Read the issued confirmed-memory ordinal for this execution.',
    inputSchema: z.toJSONSchema(
      MemoryOrdinalInputSchema,
    ) as Tool['inputSchema'],
    annotations: { readOnlyHint: true },
  },
  {
    name: 'deliverable_create',
    description:
      'Save generated deliverable bytes and return its real version.',
    inputSchema: deliverySchema as Tool['inputSchema'],
  },
];
const moduleForTool = {
  reference_read: 'enterprise-materials',
  memory_read: 'employee-memory',
  deliverable_create: 'deliverables',
} as const;
type BusinessTool = keyof typeof moduleForTool;
const bindingSchema = z.object({
  personId: UuidSchema,
  organizationId: UuidSchema,
  workspaceId: UuidSchema.nullable(),
  employeeInstanceId: UuidSchema,
  allriceThreadRef: UuidSchema,
  executionGeneration: ExecutionGenerationSchema,
  nativeSessionRef: z.object({
    instanceId: z.string().min(1),
    profileId: z.string().min(1),
    sessionId: z.string().min(1),
  }),
});

export function allriceMcpApiError(
  scope: AllriceMcpScope,
  code: z.infer<typeof ApiErrorSchema>['error']['code'],
  message: string,
  retryable = false,
): CallToolResult {
  const value = ApiErrorSchema.parse({
    error: {
      code,
      message,
      requestId: scope.requestContext.requestId,
      retryable,
    },
  });
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(value) }],
  };
}

/** One SDK-native server per authenticated managed connection. This function
 * opens no socket, reads no credentials and enables no builtin by default.
 * The advanced SDK API preserves the existing full JSON Schema unchanged.
 * DSH owns public mcp__ names; these are exclusively the raw wire names. */
export function createAllriceMcpServer(options: {
  host?: AllriceMcpHost;
  services?: AllriceMcpServices;
}) {
  const parsedBinding = bindingSchema.safeParse(options.host?.binding);
  const binding = parsedBinding.success ? parsedBinding.data : null;
  const shutdown = new AbortController();
  const active = new Set<Promise<unknown>>();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const server = new Server(
    { name: 'allrice', version: '1' },
    { capabilities: { tools: { listChanged: true } } },
  );
  const sameBinding = (scope: AllriceMcpScope) =>
    binding !== null &&
    scope.personId === binding.personId &&
    scope.organizationId === binding.organizationId &&
    scope.workspaceId === binding.workspaceId &&
    scope.employeeInstanceId === binding.employeeInstanceId &&
    scope.allriceThreadRef === binding.allriceThreadRef &&
    scope.executionGeneration === binding.executionGeneration &&
    scope.nativeSessionRef.instanceId === binding.nativeSessionRef.instanceId &&
    scope.nativeSessionRef.profileId === binding.nativeSessionRef.profileId &&
    scope.nativeSessionRef.sessionId === binding.nativeSessionRef.sessionId;
  async function current(
    requestId: string | number,
    toolName: string | null,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    if (closing || !options.host || !binding)
      throw new McpError(
        ErrorCode.InvalidRequest,
        'Managed binding unavailable',
      );
    let scope: AllriceMcpScope;
    let context: RequestContext;
    try {
      scope = await options.host.current({ requestId, toolName }, signal);
      context = RequestContextSchema.parse(scope.requestContext);
    } catch {
      signal.throwIfAborted();
      throw new McpError(
        ErrorCode.InvalidRequest,
        'Managed binding unavailable',
      );
    }
    if (
      !Array.isArray(scope.enabledModules) ||
      !['3.x', '4.0'].includes(scope.executionGeneration) ||
      !scope.nativeSessionRef ||
      !sameBinding(scope) ||
      context.actor.type !== 'user' ||
      context.actor.id !== binding.personId ||
      context.organizationId !== binding.organizationId ||
      context.workspaceId !== binding.workspaceId ||
      typeof scope.moduleConfigRevisionRef !== 'string' ||
      !scope.moduleConfigRevisionRef ||
      (toolName !== null &&
        (typeof scope.nativeCallRef !== 'string' || !scope.nativeCallRef))
    )
      throw new McpError(
        ErrorCode.InvalidRequest,
        'Managed binding unavailable',
      );
    signal.throwIfAborted();
    return {
      ...scope,
      nativeSessionRef: { ...scope.nativeSessionRef },
      enabledModules: [...scope.enabledModules],
      requestContext: context,
    };
  }
  function enabled(scope: AllriceMcpScope, name: string) {
    if (name === 'identity_read') return true;
    if (!Object.hasOwn(moduleForTool, name)) return false;
    const services = options.services;
    if (!services || services.executionGeneration !== scope.executionGeneration)
      return false;
    const method =
      name === 'reference_read'
        ? services.referenceRead
        : name === 'memory_read'
          ? services.memoryRead
          : services.deliverableCreate;
    return (
      !!method &&
      scope.enabledModules.includes(moduleForTool[name as BusinessTool])
    );
  }
  async function operation<T>(
    signal: AbortSignal,
    work: (signal: AbortSignal) => Promise<T>,
  ) {
    const combined = AbortSignal.any([signal, shutdown.signal]);
    const promise = Promise.resolve().then(() => {
      combined.throwIfAborted();
      return work(combined);
    });
    active.add(promise);
    try {
      return await promise;
    } finally {
      active.delete(promise);
    }
  }
  server.setRequestHandler(ListToolsRequestSchema, (request, extra) =>
    operation(extra.signal, async (signal) => {
      if (!options.host || closing) return { tools: [] };
      const scope = await current(extra.requestId, null, signal);
      return { tools: tools.filter((tool) => enabled(scope, tool.name)) };
    }),
  );
  server.setRequestHandler(CallToolRequestSchema, (request, extra) =>
    operation(extra.signal, async (signal) => {
      const { name, arguments: args = {} } = request.params;
      const scope = await current(extra.requestId, name, signal);
      if (!enabled(scope, name))
        return allriceMcpApiError(
          scope,
          'DEPENDENCY_UNAVAILABLE',
          'This tool is currently unavailable.',
        );
      const services = options.services;
      let result: CallToolResult;
      try {
        if (name === 'identity_read') {
          z.object({}).strict().parse(args);
          result = {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  personId: scope.personId,
                  organizationId: scope.organizationId,
                  workspaceId: scope.workspaceId,
                  employeeInstanceId: scope.employeeInstanceId,
                }),
              },
            ],
          };
        } else if (name === 'reference_read') {
          result = await services!.referenceRead!(
            scope,
            ReferenceReadInputSchema.parse(args),
            signal,
          );
        } else if (name === 'memory_read') {
          result = await services!.memoryRead!(
            scope,
            MemoryOrdinalInputSchema.parse(args),
            signal,
          );
        } else {
          const validated = validateDelivery(args);
          if (!validated.valid)
            throw new McpError(
              ErrorCode.InvalidParams,
              'Invalid deliverable arguments',
            );
          result = await services!.deliverableCreate!(
            scope,
            validated.data,
            signal,
          );
        }
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof McpError) throw error;
        if (error instanceof z.ZodError)
          throw new McpError(ErrorCode.InvalidParams, 'Invalid tool arguments');
        // Preserve existing named business errors, never serialize arbitrary
        // thrown objects, SQL/stack details or transport credentials.
        const known = ApiErrorSchema.safeParse(error);
        const selection = ReferenceSelectionErrorSchema.safeParse(error);
        if (
          selection.success &&
          (name !== 'reference_read' ||
            selection.data.error.referenceRevisionIds.some(
              (id) => id !== args.revisionId,
            ))
        )
          throw new McpError(
            ErrorCode.InternalError,
            'Invalid module selection error',
          );
        if (known.success || selection.success)
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  known.success ? known.data : selection.data,
                ),
              },
            ],
          };
        throw new McpError(
          ErrorCode.InternalError,
          'AllRice business service failed',
        );
      }
      signal.throwIfAborted();
      // A current host cutoff also prevents a stale, completed read being
      // disclosed. This is not a rollback statement for a committed write.
      const latest = await current(extra.requestId, name, signal);
      if (
        latest.nativeCallRef !== scope.nativeCallRef ||
        latest.moduleConfigRevisionRef !== scope.moduleConfigRevisionRef ||
        !enabled(latest, name)
      )
        return allriceMcpApiError(
          latest,
          'AUTHORIZATION_DENIED',
          name === 'deliverable_create'
            ? 'Current access is unavailable. Publication may already be committed; reconcile the original call before retrying.'
            : 'Current access is unavailable.',
        );
      return CallToolResultSchema.parse(result);
    }),
  );
  server.onclose = () => {
    closing = true;
    shutdown.abort();
  };
  const whenIdle = async () => {
    while (active.size) await Promise.allSettled([...active]);
  };
  return {
    server,
    /** Owner config/revocation notification. Calls still check current rights
     * even if native discovery later fails and keeps its previous catalog. */
    notifyCatalogChanged: () => server.sendToolListChanged(),
    whenIdle,
    close() {
      return (closePromise ??= (async () => {
        closing = true;
        shutdown.abort();
        try {
          await whenIdle();
        } finally {
          await server.close();
        }
      })());
    },
  };
}
