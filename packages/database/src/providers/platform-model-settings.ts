import { randomUUID } from 'node:crypto';
import {
  PlatformModelSettingsSchema,
  UpdatePlatformModelSettingsSchema,
  type PlatformEmployeeDefinition,
  type RequestContext,
} from '@allrice/contracts';
import { getDatabase } from '../core/client.ts';
import { DataAccessError } from '../data.ts';
import { requirePlatformAdmin } from '../platform-authority.ts';

export class PlatformModelSettingsConflict extends Error {
  constructor() {
    super('platform_model_settings_conflict');
  }
}

/** Internal execution read. Callers must already own their Run/context. */
export async function readPlatformModelSettings() {
  const [row] = await getDatabase()<
    {
      revision: number;
      configuration: unknown;
      updated_at: Date;
    }[]
  >`select revision, configuration, updated_at from allrice_platform_model_settings where singleton`;
  if (!row) throw new DataAccessError('not_found');
  return PlatformModelSettingsSchema.parse({
    revision: row.revision,
    configuration: row.configuration,
    updatedAt: row.updated_at.toISOString(),
  });
}

export async function getPlatformModelSettings(context: RequestContext) {
  await requirePlatformAdmin(context);
  return readPlatformModelSettings();
}

export async function updatePlatformModelSettings(
  context: RequestContext,
  input: unknown,
) {
  const actorId = await requirePlatformAdmin(context);
  const { expectedRevision, configuration } =
    UpdatePlatformModelSettingsSchema.parse(input);
  const sql = getDatabase();
  return sql.begin(async (tx) => {
    const [connection] = await tx<{ provider_id: string }[]>`
      select c.provider_id from allrice_model_connections c
      join allrice_model_providers p on p.id=c.provider_id
      where c.id=${configuration.connectionId} and c.scope='platform'
        and c.credential_reference='deployment:codex-default' and c.base_url is null
        and c.status='ready' and p.enabled
        and p.provider_key in ('codex','openai-codex') and p.auth_mode='chatgpt_subscription'`;
    if (!connection) throw new DataAccessError('grant_invalid');
    const [row] = await tx<
      { revision: number; configuration: unknown; updated_at: Date }[]
    >`
      update allrice_platform_model_settings
      set configuration=${tx.json(configuration)},revision=revision+1,updated_by=${actorId},updated_at=now()
      where singleton and revision=${expectedRevision}
      returning revision,configuration,updated_at`;
    if (!row) throw new PlatformModelSettingsConflict();
    await tx`insert into allrice_model_catalog_entries (
      id,provider_id,model,display_name,reasoning_efforts,default_reasoning_effort,input_modalities,output_modalities,enabled,stability
    ) values (${randomUUID()},${connection.provider_id},${configuration.workModel},${configuration.workModel},
      '["low","medium","high","xhigh"]'::jsonb,'xhigh','["text","image","file"]'::jsonb,'["text"]'::jsonb,true,'production')
      on conflict (provider_id,model) do nothing`;
    await tx`insert into allrice_audit_events (
      organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,request_id,metadata
    ) values (${context.organizationId},${context.workspaceId},${actorId},'platform_models.update','model_connection',
      ${configuration.connectionId},'recorded','platform_admin',${context.requestId},
      ${tx.json({ revision: row.revision, configuration })})`;
    return PlatformModelSettingsSchema.parse({
      revision: row.revision,
      configuration: row.configuration,
      updatedAt: row.updated_at.toISOString(),
    });
  });
}

export async function platformEmployeeModelPolicy(): Promise<
  PlatformEmployeeDefinition['modelPolicy']
> {
  const { configuration } = await readPlatformModelSettings();
  return {
    provider: 'openai-codex',
    model: configuration.workModel,
    reasoningEffort: configuration.reasoningEffort,
    timeoutMs: configuration.timeoutMs,
    credentialReference: 'deployment:codex-default',
    baseUrl: null,
    fallbackModels: [],
  };
}
