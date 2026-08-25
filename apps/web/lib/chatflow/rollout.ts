import {
  ChatFlowRealtimeRolloutPolicySchema,
  resolveChatFlowRealtimeRollout,
  type ChatFlowRealtimeRolloutContext,
  type ChatFlowRealtimeRolloutPolicy,
} from '@allrice/contracts';

const defaultPolicy: ChatFlowRealtimeRolloutPolicy = {
  schemaVersion: 1,
  emergencyOff: false,
  defaultEnabled: true,
  organizationIds: [],
  workspaceIds: [],
  employeeVersionIds: [],
  harnesses: [],
};

export function readChatFlowRealtimePolicy() {
  const encoded = process.env.ALLRICE_CHATFLOW_REALTIME_ROLLOUT_JSON;
  if (!encoded) {
    return {
      ...defaultPolicy,
      emergencyOff: process.env.ALLRICE_CHATFLOW_REALTIME === '0',
    };
  }
  try {
    return ChatFlowRealtimeRolloutPolicySchema.parse(JSON.parse(encoded));
  } catch (error) {
    console.error('[ChatFlow] Invalid realtime rollout policy', {
      message: error instanceof Error ? error.message : 'invalid policy',
    });
    return { ...defaultPolicy, emergencyOff: true, defaultEnabled: false };
  }
}

export function chatFlowRealtimeEnabled(
  context: ChatFlowRealtimeRolloutContext,
) {
  return resolveChatFlowRealtimeRollout(readChatFlowRealtimePolicy(), context);
}
