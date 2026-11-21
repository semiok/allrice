import { randomUUID } from 'node:crypto';
import {
  ApiErrorSchema,
  ReferenceSelectionErrorSchema,
} from '@allrice/contracts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it } from 'vitest';
import { fixture } from './testing.fixture.js';
import { ApprovalError } from './contract.js';
import { createApprovalGateway } from './gateway.js';
import { createApprovalBrowserHandler } from './browser.js';
import { createApprovalMcpServer } from './mcp.js';
import { ApprovalOwnerError, approvalPublicError } from './errors.js';

const signal = () => new AbortController().signal;
function referenceFailure(id: string) {
  return {
    error: {
      code: 'REFERENCE_SELECTION_UNAVAILABLE',
      message: 'upstream secret must never escape',
      requestId: randomUUID(),
      retryable: false,
      referenceRevisionIds: [id],
    },
  };
}
it('retains the reference-owner error through native MCP without leaking arbitrary messages', async () => {
  const f = fixture(),
    id = randomUUID();
  const gateway = createApprovalGateway({
    ...f.options,
    resources: {
      files: {
        ...f.options.resources.files,
        snapshot: async () => {
          throw new ApprovalOwnerError(referenceFailure(id), [id]);
        },
      },
    },
  });
  const { server } = createApprovalMcpServer({
    gateway,
    enabled: true,
    resolveCall: async () => f.binding,
  });
  const client = new Client({ name: 'error-contract', version: '1' }),
    [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b);
    await client.connect(a);
    const result = await client.callTool({
      name: 'outbound.stage',
      arguments: { ...f.input, attachments: [{ module: 'files', ref: id }] },
    });
    expect(result.isError).toBe(true);
    const parsed = ReferenceSelectionErrorSchema.parse(
      result.structuredContent,
    );
    expect(parsed.error.referenceRevisionIds).toEqual([id]);
    expect(parsed.error.retryable).toBe(false);
    expect(JSON.stringify(result)).not.toContain('upstream secret');
  } finally {
    await client.close();
    await server.close();
  }
});
it.each(['reference', 'dependency'] as const)(
  'returns an existing BFF schema for %s owner errors',
  async (kind) => {
    const f = fixture(),
      id = randomUUID();
    f.options.resources.files.snapshot = async () => ({
      ref: id,
      filename: 'file.txt',
      mediaType: 'text/plain',
      bytes: Buffer.from('frozen'),
    });
    const view = await f.gateway.stage(
      f.binding,
      { ...f.input, attachments: [{ module: 'files', ref: id }] },
      signal(),
    );
    const gateway = createApprovalGateway({
      ...f.options,
      resources: {
        files: {
          ...f.options.resources.files,
          assertCurrent: async () => {
            throw kind === 'reference'
              ? new ApprovalOwnerError(referenceFailure(id), [id])
              : new ApprovalOwnerError({
                  error: {
                    code: 'DEPENDENCY_UNAVAILABLE',
                    message: 'private URL token',
                    requestId: randomUUID(),
                    retryable: true,
                  },
                });
          },
        },
      },
    });
    const handle = createApprovalBrowserHandler({
      gateway,
      trustedOrigin: 'https://allrice.test',
      guestOrigins: ['https://guest.test'],
      maxRequestBytes: 1000,
      authenticate: async () => f.context,
      assertCsrf: async () => {},
    });
    const response = await handle(
      new Request('https://allrice.test/approvals/view', {
        method: 'POST',
        headers: {
          origin: 'https://allrice.test',
          'sec-fetch-site': 'same-origin',
          'content-type': 'application/json',
        },
        body: JSON.stringify(view.ref),
      }),
    );
    const parsed = (
      kind === 'reference' ? ReferenceSelectionErrorSchema : ApiErrorSchema
    ).parse(await response.json());
    expect(response.status).toBe(kind === 'reference' ? 403 : 503);
    expect(parsed.error.requestId).toBe(f.context.requestId);
    expect(parsed.error.retryable).toBe(kind === 'dependency');
    expect(JSON.stringify(parsed)).not.toContain('private URL');
    expect(JSON.stringify(parsed)).not.toContain('upstream secret');
  },
);
it('rejects foreign IDs and arbitrary public-detail extensions rather than forwarding exceptions', () => {
  expect(
    () =>
      new ApprovalOwnerError(referenceFailure(randomUUID()), [randomUUID()]),
  ).toThrow(ApprovalError);
  expect(
    () =>
      new ApprovalOwnerError({
        error: {
          code: 'DEPENDENCY_UNAVAILABLE',
          message: 'x',
          requestId: randomUUID(),
          retryable: true,
          details: { token: 'private' },
        },
      }),
  ).toThrow();
  const unknown = ApiErrorSchema.parse(
    approvalPublicError(Error('secret token')),
  );
  expect(unknown.error.code).toBe('INTERNAL_ERROR');
  expect(unknown.error.retryable).toBe(false);
  expect(JSON.stringify(unknown)).not.toContain('secret token');
});
it('retains a safe named owner failure after intent without changing unknown into resend', async () => {
  const f = fixture();
  const gateway = createApprovalGateway({
    ...f.options,
    destinations: {
      inbox: {
        ...f.options.destinations.inbox,
        dispatch: async () => {
          throw new ApprovalOwnerError({
            error: {
              code: 'DEPENDENCY_UNAVAILABLE',
              message: 'secret endpoint',
              requestId: randomUUID(),
              retryable: true,
            },
          });
        },
      },
    },
  });
  const view = await gateway.stage(f.binding, f.input, signal());
  await gateway.decide(
    f.context,
    { ...view.ref, decision: 'approved' },
    signal(),
  );
  const result = await gateway.execute(f.binding, view.ref, signal());
  expect(result.effect).toBe('unknown');
  expect(result.failure?.publicError?.error).toMatchObject({
    code: 'DEPENDENCY_UNAVAILABLE',
    retryable: true,
  });
  expect(JSON.stringify(result)).not.toContain('secret endpoint');
  expect(
    (await gateway.execute(f.binding, view.ref, signal())).failure,
  ).toEqual(result.failure);
});
