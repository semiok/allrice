import {
  FrameworkRolloutPolicySchema,
  type FrameworkRolloutPolicy,
} from '@allrice/contracts';

const defaultPolicy: FrameworkRolloutPolicy = {
  schemaVersion: 1,
  emergencyOff: false,
  defaultEnabled: true,
  organizationIds: [],
  workspaceIds: [],
  employeeVersionIds: [],
  surfaces: [],
};

export function readFrameworkRolloutPolicy(): FrameworkRolloutPolicy {
  const encoded = process.env.ALLRICE_FRAMEWORK_V2_ROLLOUT_JSON;
  if (!encoded) {
    return {
      ...defaultPolicy,
      emergencyOff: process.env.ALLRICE_FRAMEWORK_V2 === '0',
    };
  }
  try {
    return FrameworkRolloutPolicySchema.parse(JSON.parse(encoded));
  } catch (error) {
    console.error('Invalid ALLRICE_FRAMEWORK_V2_ROLLOUT_JSON', {
      message: error instanceof Error ? error.message : 'invalid policy',
    });
    return { ...defaultPolicy, emergencyOff: true, defaultEnabled: false };
  }
}
