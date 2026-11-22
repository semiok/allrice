import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  ToolSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import {
  ApiErrorSchema,
  ExecutionGenerationSchema,
  MemoryOrdinalInputSchema,
  ReferenceArchiveListInputSchema,
  ReferenceArchiveReadInputSchema,
  ReferenceReadImageInputSchema,
  ReferenceReadInputSchema,
  ReferenceSearchInputSchema,
  ReferenceSelectionErrorSchema,
  RememberPersonalMemoryInputSchema,
  RequestContextSchema,
  UuidSchema,
  WorkspaceDocumentReadArgsSchema,
  type DeliveryFormat,
  type ExecutionGeneration,
  type NativeOfficeExportSchema,
  type OfficePdfExportSchema,
  type ReferenceReadInput,
  type RequestContext,
} from '@allrice/contracts';
import { z } from 'zod';
import { riceToolDefinitions } from '../tool-broker/definitions.js';

/** Host API version, not a guest-supplied authorization or business schema. */
export const ALLRICE_MCP_CONTRACT_VERSION = 1 as const;

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
  /** Each returned Promise must join the owner's actual I/O/transaction. A
   * canceled response does not undo an already committed receipt or effect. */
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
  referenceSearch?(
    scope: AllriceMcpScope,
    input: z.input<typeof ReferenceSearchInputSchema>,
    signal: AbortSignal,
  ): Promise<CallToolResult>;
  referenceReadImage?(
    scope: AllriceMcpScope,
    input: z.input<typeof ReferenceReadImageInputSchema>,
    signal: AbortSignal,
  ): Promise<CallToolResult>;
  referenceArchiveList?(
    scope: AllriceMcpScope,
    input: z.input<typeof ReferenceArchiveListInputSchema>,
    signal: AbortSignal,
  ): Promise<CallToolResult>;
  referenceArchiveRead?(
    scope: AllriceMcpScope,
    input: z.input<typeof ReferenceArchiveReadInputSchema>,
    signal: AbortSignal,
  ): Promise<CallToolResult>;
  deliverableDocumentRead?(
    scope: AllriceMcpScope,
    input: z.input<typeof WorkspaceDocumentReadArgsSchema>,
    signal: AbortSignal,
  ): Promise<CallToolResult>;
  memoryRemember?(
    scope: AllriceMcpScope,
    input: z.input<typeof RememberPersonalMemoryInputSchema>,
    signal: AbortSignal,
  ): Promise<CallToolResult>;
}

/** Public host callbacks for MET-281/283 adapters. These are the exact existing
 * M1 signatures, not the proposed complete business Ports or a 4.0 carrier. */
export type AllriceMcpReferenceRead = NonNullable<
  AllriceMcpServices['referenceRead']
>;
export type AllriceMcpMemoryRead = NonNullable<
  AllriceMcpServices['memoryRead']
>;
export type AllriceMcpDeliverableCreate = NonNullable<
  AllriceMcpServices['deliverableCreate']
>;
/** Optional M2 callbacks, with native SDK results and no business carrier. */
export type AllriceMcpReferenceSearch = NonNullable<
  AllriceMcpServices['referenceSearch']
>;
export type AllriceMcpReferenceReadImage = NonNullable<
  AllriceMcpServices['referenceReadImage']
>;
export type AllriceMcpReferenceArchiveList = NonNullable<
  AllriceMcpServices['referenceArchiveList']
>;
export type AllriceMcpReferenceArchiveRead = NonNullable<
  AllriceMcpServices['referenceArchiveRead']
>;
export type AllriceMcpDeliverableDocumentRead = NonNullable<
  AllriceMcpServices['deliverableDocumentRead']
>;
export type AllriceMcpMemoryRemember = NonNullable<
  AllriceMcpServices['memoryRemember']
>;
/** Only these existing thrown payloads are validated and disclosed. Native
 * CallToolResult.isError remains the owner's ordinary tool-failure channel. */
export type AllriceMcpBusinessError =
  | z.infer<typeof ApiErrorSchema>
  | z.infer<typeof ReferenceSelectionErrorSchema>;
export interface AllriceMcpServerOptions {
  host?: AllriceMcpHost;
  services?: AllriceMcpServices;
}
export interface AllriceMcpServerPort {
  readonly contractVersion: typeof ALLRICE_MCP_CONTRACT_VERSION;
  /** Use the SDK's public connect(transport); this API adds no handshake,
   * reconnect or retry. The transport owner must supply the managed route. */
  readonly server: Server;
  notifyCatalogChanged(): Promise<void>;
  /** Passive wait only: never cancels current work or grants admission. */
  whenIdle(): Promise<void>;
  /** Permanently stop this connection's admission, abort its operations, join
   * their actual Promises, then close the SDK. Other connections are untouched.
   * The host must wire its trusted revocation notification to this method. */
  revoke(): Promise<void>;
  /** Same joined shutdown, idempotent with revoke. Never replays a call or
   * treats cancellation/ACK loss as rollback or permission to republish. */
  close(): Promise<void>;
}

const deliverySourceSchema = riceToolDefinitions.find(
  (tool) => tool.name === 'workspace.export.create',
)!.inputSchema;
// Preserve the complete wire JSON, including nested oneOf/allOf/defaults and
// refinements. SDK parsing checks its MCP shape without projecting a subset.
// This also removes undefined-only implementation properties that have no
// representation on the wire and reconciles the schema libraries' TS types.
const deliveryWireSchema: unknown = JSON.parse(
  JSON.stringify(deliverySourceSchema),
);
const deliverySchema = ToolSchema.shape.inputSchema.parse(deliveryWireSchema);
const validateDelivery =
  new AjvJsonSchemaValidator().getValidator<AllriceMcpDeliverableInput>(
    deliverySchema,
  );
const rememberSourceSchema = riceToolDefinitions.find(
  (tool) => tool.name === 'workspace.memory.remember',
)!.inputSchema;
const rememberWireSchema: unknown = JSON.parse(
  JSON.stringify(rememberSourceSchema),
);
const rememberSchema = ToolSchema.shape.inputSchema.parse(rememberWireSchema);
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
    inputSchema: deliverySchema,
  },
  {
    name: 'reference_search',
    description: 'Search currently authorized enterprise materials.',
    inputSchema: z.toJSONSchema(ReferenceSearchInputSchema, {
      io: 'input',
    }) as Tool['inputSchema'],
    annotations: { readOnlyHint: true },
  },
  {
    name: 'reference_read_image',
    description: 'Read an authorized exact enterprise-material image.',
    inputSchema: z.toJSONSchema(ReferenceReadImageInputSchema, {
      io: 'input',
    }) as Tool['inputSchema'],
    annotations: { readOnlyHint: true },
  },
  {
    name: 'reference_archive_list',
    description: 'List the directory of an authorized exact reference archive.',
    inputSchema: z.toJSONSchema(ReferenceArchiveListInputSchema, {
      io: 'input',
    }) as Tool['inputSchema'],
    annotations: { readOnlyHint: true },
  },
  {
    name: 'reference_archive_read',
    description: 'Read one member of an authorized exact reference archive.',
    inputSchema: z.toJSONSchema(ReferenceArchiveReadInputSchema, {
      io: 'input',
    }) as Tool['inputSchema'],
    annotations: { readOnlyHint: true },
  },
  {
    name: 'deliverable_document_read',
    description: 'Read a currently authorized deliverable document.',
    inputSchema: z.toJSONSchema(WorkspaceDocumentReadArgsSchema, {
      io: 'input',
    }) as Tool['inputSchema'],
    annotations: { readOnlyHint: true },
  },
  {
    name: 'memory_remember',
    description:
      'Save current human-message content as a candidate requiring confirmation.',
    inputSchema: rememberSchema,
  },
];
const moduleForTool = {
  reference_read: 'enterprise-materials',
  memory_read: 'employee-memory',
  deliverable_create: 'deliverables',
  reference_search: 'enterprise-materials',
  reference_read_image: 'enterprise-materials',
  reference_archive_list: 'enterprise-materials',
  reference_archive_read: 'enterprise-materials',
  deliverable_document_read: 'deliverables',
  memory_remember: 'employee-memory',
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
export function createAllriceMcpServer(
  options: AllriceMcpServerOptions,
): AllriceMcpServerPort {
  const parsedBinding = bindingSchema.safeParse(options.host?.binding);
  const binding = parsedBinding.success ? parsedBinding.data : null;
  const shutdown = new AbortController();
  const active = new Set<Promise<unknown>>();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const server = new Server(
    { name: 'allrice', version: String(ALLRICE_MCP_CONTRACT_VERSION) },
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
    let bound = false;
    switch (name) {
      case 'reference_read':
        bound = !!services.referenceRead;
        break;
      case 'memory_read':
        bound = !!services.memoryRead;
        break;
      case 'deliverable_create':
        bound = !!services.deliverableCreate;
        break;
      case 'reference_search':
        bound = !!services.referenceSearch;
        break;
      case 'reference_read_image':
        bound = !!services.referenceReadImage;
        break;
      case 'reference_archive_list':
        bound = !!services.referenceArchiveList;
        break;
      case 'reference_archive_read':
        bound = !!services.referenceArchiveRead;
        break;
      case 'deliverable_document_read':
        bound = !!services.deliverableDocumentRead;
        break;
      case 'memory_remember':
        bound = !!services.memoryRemember;
        break;
    }
    return (
      bound &&
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
        } else if (name === 'reference_search') {
          result = await services!.referenceSearch!(
            scope,
            ReferenceSearchInputSchema.parse(args),
            signal,
          );
        } else if (name === 'reference_read_image') {
          result = await services!.referenceReadImage!(
            scope,
            ReferenceReadImageInputSchema.parse(args),
            signal,
          );
        } else if (name === 'reference_archive_list') {
          result = await services!.referenceArchiveList!(
            scope,
            ReferenceArchiveListInputSchema.parse(args),
            signal,
          );
        } else if (name === 'reference_archive_read') {
          result = await services!.referenceArchiveRead!(
            scope,
            ReferenceArchiveReadInputSchema.parse(args),
            signal,
          );
        } else if (name === 'deliverable_document_read') {
          result = await services!.deliverableDocumentRead!(
            scope,
            WorkspaceDocumentReadArgsSchema.parse(args),
            signal,
          );
        } else if (name === 'memory_remember') {
          result = await services!.memoryRemember!(
            scope,
            RememberPersonalMemoryInputSchema.parse(args),
            signal,
          );
        } else if (name === 'deliverable_create') {
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
        } else {
          throw new McpError(ErrorCode.InvalidParams, 'Invalid tool arguments');
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
          (![
            'reference_read',
            'reference_read_image',
            'reference_archive_list',
            'reference_archive_read',
          ].includes(name) ||
            selection.data.error.referenceRevisionIds.some(
              (id) => id !== args.revisionId,
            ))
        )
          throw new McpError(
            ErrorCode.InternalError,
            'Invalid module selection error',
          );
        if (known.success || selection.success)
          result = {
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
        else
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
            : name === 'memory_remember'
              ? 'Current access is unavailable. Candidate may already be committed; reconcile the original call before retrying.'
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
  const close = () =>
    (closePromise ??= (async () => {
      closing = true;
      shutdown.abort();
      try {
        await whenIdle();
      } finally {
        await server.close();
      }
    })());
  return {
    contractVersion: ALLRICE_MCP_CONTRACT_VERSION,
    server,
    /** Owner config/revocation notification. Calls still check current rights
     * even if native discovery later fails and keeps its previous catalog. */
    notifyCatalogChanged: () => server.sendToolListChanged(),
    whenIdle,
    revoke: close,
    close,
  };
}
