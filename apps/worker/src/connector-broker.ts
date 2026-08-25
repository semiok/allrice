import {
  completeConnectorCall,
  getApprovedConnectorCallForExecution,
  prepareConnectorCall,
} from '@allrice/database';
import type {
  ConnectorCallRequest,
  ExecutionContext,
  SkillCapability,
} from '@allrice/contracts';

import { HandlerError } from './errors.js';

export interface ConnectorCredentialResolver {
  resolve(input: {
    reference: string;
    organizationId: string;
    workspaceId: string;
    actorId: string;
  }): Promise<Readonly<Record<string, string>>>;
}

export class DeploymentConnectorCredentialResolver implements ConnectorCredentialResolver {
  async resolve(input: {
    reference: string;
    organizationId: string;
    workspaceId: string;
    actorId: string;
  }) {
    let directory: unknown = {};
    try {
      directory = process.env.ALLRICE_CONNECTOR_CREDENTIALS_JSON
        ? JSON.parse(process.env.ALLRICE_CONNECTOR_CREDENTIALS_JSON)
        : {};
    } catch {
      throw new HandlerError(
        'CONNECTOR_CREDENTIAL_DIRECTORY_INVALID',
        'The connector credential directory is invalid',
        false,
      );
    }
    const value =
      directory && typeof directory === 'object' && !Array.isArray(directory)
        ? (directory as Record<string, unknown>)[input.reference]
        : null;
    const binding =
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
    const credentials =
      binding?.credentials &&
      typeof binding.credentials === 'object' &&
      !Array.isArray(binding.credentials)
        ? (binding.credentials as Record<string, unknown>)
        : null;
    const tenantMatches =
      binding?.scope === 'deployment' ||
      (binding?.organizationId === input.organizationId &&
        binding.workspaceId === input.workspaceId &&
        (binding.actorId === null || binding.actorId === input.actorId));
    if (
      !binding ||
      !credentials ||
      !tenantMatches ||
      !Object.values(credentials).every(
        (credential) =>
          typeof credential === 'string' &&
          credential.trim() &&
          !/[\r\n]/.test(credential),
      )
    ) {
      throw new HandlerError(
        'CONNECTOR_CREDENTIAL_UNAVAILABLE',
        'The connector credential is unavailable for this tenant identity',
        false,
      );
    }
    return Object.fromEntries(
      Object.entries(credentials).map(([key, credential]) => [
        key,
        (credential as string).trim(),
      ]),
    );
  }
}

export interface ConnectorTransport {
  execute(input: {
    operation: string;
    payload: Record<string, unknown>;
    credential: Readonly<Record<string, string>>;
    resourceScope: Readonly<Record<string, unknown>>;
    signal: AbortSignal;
  }): Promise<{ modelContent: string; summary: string; rawOutput: unknown }>;
}

export class ConnectorBroker {
  constructor(
    private readonly credentialResolver: ConnectorCredentialResolver,
    private readonly transports: ReadonlyMap<string, ConnectorTransport>,
  ) {}

  async execute(input: {
    context: ExecutionContext;
    request: ConnectorCallRequest;
    grantedCapabilities: SkillCapability[];
    allowedIdentityModes: ('user' | 'service')[];
    signal: AbortSignal;
  }) {
    const decision = await prepareConnectorCall(input);
    if (decision.status === 'waiting_approval') {
      throw new HandlerError(
        'APPROVAL_REQUIRED',
        `Connector action requires approval ${decision.approvalId}`,
        false,
      );
    }
    if (decision.status !== 'allowed') {
      throw new HandlerError(
        'CONNECTOR_DENIED',
        'Connector call was denied by policy',
        false,
      );
    }
    const execution = await getApprovedConnectorCallForExecution({
      context: input.context,
      callId: decision.callId,
    });
    const transport = this.transports.get(execution.connectorKey);
    if (!transport) {
      await completeConnectorCall({
        context: input.context,
        callId: decision.callId,
        errorCode: 'CONNECTOR_TRANSPORT_UNAVAILABLE',
      });
      throw new HandlerError(
        'CONNECTOR_TRANSPORT_UNAVAILABLE',
        'The connector transport is not installed in this deployment',
        true,
      );
    }
    const credential = await this.credentialResolver.resolve({
      reference: execution.credentialReference,
      organizationId: input.context.organizationId,
      workspaceId: input.context.workspaceId!,
      actorId: input.context.policySnapshot.subjectId,
    });
    try {
      const result = await transport.execute({
        operation: execution.operation,
        payload: input.request.input,
        credential,
        resourceScope: execution.resourceScope,
        signal: input.signal,
      });
      await completeConnectorCall({
        context: input.context,
        callId: decision.callId,
        output: result.rawOutput,
      });
      return result;
    } catch (error) {
      await completeConnectorCall({
        context: input.context,
        callId: decision.callId,
        errorCode: 'CONNECTOR_EXECUTION_FAILED',
      }).catch(() => undefined);
      throw error;
    }
  }
}
