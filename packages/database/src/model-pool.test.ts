import { describe, expect, it } from 'vitest';

import { buildSaasCapabilityManifest } from './model-pool.js';

describe('SaaS capability manifest', () => {
  it('keeps member navigation free of administrator surfaces', () => {
    const manifest = buildSaasCapabilityManifest({
      member: true,
      tenantAdmin: false,
      platformAdmin: false,
    });

    expect(manifest.roles).toEqual(['member']);
    expect(manifest.surfaces).toEqual(['chatflow']);
    expect(manifest.actions).toContain('conversation:send');
    expect(manifest.actions).not.toContain('employee:manage');
    expect(manifest.actions).not.toContain('model_connection:manage');
  });

  it('separates tenant configuration from platform secret management', () => {
    const tenantAdmin = buildSaasCapabilityManifest({
      member: true,
      tenantAdmin: true,
      platformAdmin: false,
    });
    expect(tenantAdmin.actions).toContain('model_policy:manage');
    expect(tenantAdmin.actions).not.toContain('model_connection:manage');

    const platformAdmin = buildSaasCapabilityManifest({
      member: true,
      tenantAdmin: true,
      platformAdmin: true,
    });
    expect(platformAdmin.actions).toContain('model_connection:manage');
    expect(platformAdmin.surfaces).toContain('platform_admin');
    expect(platformAdmin.features.chatFlowV3).toBe(true);
  });
});
