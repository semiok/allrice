import type { DshExecutionSnapshot } from '@allrice/contracts';
import { readFile, stat } from 'node:fs/promises';

import { HandlerError } from '../errors.js';

export interface DshCredentialRequest {
  reference: string;
  organizationId: string;
  workspaceId: string;
  ownerId: string;
  route: DshExecutionSnapshot['route'];
}

export interface DshCredential {
  apiKey: string;
}

export interface DshCredentialResolver {
  resolve(input: DshCredentialRequest): Promise<DshCredential>;
}

/**
 * Deployment bridge for the AllRice secret layer. The JSON object is consumed
 * only by the Worker and only the selected value enters one isolated child.
 * Adapters never read arbitrary environment variable names supplied by users.
 */
export class DeploymentDshCredentialResolver implements DshCredentialResolver {
  async resolve(input: DshCredentialRequest): Promise<DshCredential> {
    let encoded = process.env.ALLRICE_DSH_CREDENTIALS_JSON;
    const credentialFile = process.env.ALLRICE_DSH_CREDENTIALS_FILE;
    if (!encoded && credentialFile) {
      try {
        const metadata = await stat(credentialFile);
        if ((metadata.mode & 0o077) !== 0) {
          throw new HandlerError(
            'DSH_CREDENTIAL_FILE_INSECURE',
            'The AllRice DSH credential file must not be group or world accessible',
            false,
          );
        }
        encoded = await readFile(credentialFile, 'utf8');
      } catch (error) {
        if (error instanceof HandlerError) throw error;
        throw new HandlerError(
          'DSH_CREDENTIAL_FILE_UNAVAILABLE',
          'The AllRice DSH credential file is unavailable',
          false,
        );
      }
    }
    let directory: unknown = {};
    try {
      directory = encoded ? JSON.parse(encoded) : {};
    } catch {
      throw new HandlerError(
        'DSH_CREDENTIAL_DIRECTORY_INVALID',
        'The AllRice DSH credential directory is invalid',
        false,
      );
    }
    const value =
      directory && typeof directory === 'object' && !Array.isArray(directory)
        ? (directory as Record<string, unknown>)[input.reference]
        : undefined;
    const binding =
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
    const tenantMatches =
      binding?.scope === 'deployment' ||
      (binding?.organizationId === input.organizationId &&
        (binding.workspaceId === null ||
          binding.workspaceId === input.workspaceId) &&
        (binding.ownerId === null || binding.ownerId === input.ownerId));
    if (
      !binding ||
      !tenantMatches ||
      typeof binding.apiKey !== 'string' ||
      !binding.apiKey.trim()
    ) {
      throw new HandlerError(
        'DSH_CREDENTIAL_UNAVAILABLE',
        'The configured DSH credential is unavailable',
        false,
      );
    }
    if (/\r|\n/.test(binding.apiKey)) {
      throw new HandlerError(
        'DSH_CREDENTIAL_INVALID',
        'The configured DSH credential is invalid',
        false,
      );
    }
    return { apiKey: binding.apiKey.trim() };
  }
}
