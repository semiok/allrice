import { runtimeFeatureEnabled } from '@allrice/contracts';
import { ChatFlowClient } from './chatflow-client';
import {
  localCommandFeatureEnabled,
  localMcpEnabled,
  experienceReviewEnabled,
  assistantRuntimeEnabled,
} from '@allrice/database';

export const dynamic = 'force-dynamic';

export default function ChatFlowPage() {
  return (
    <ChatFlowClient
      workbenchEnabled={runtimeFeatureEnabled('ALLRICE_WORKBENCH_ENABLED')}
      localCommandsEnabled={localCommandFeatureEnabled()}
      localMcpEnabled={localMcpEnabled()}
      experienceEnabled={experienceReviewEnabled()}
      assistantsEnabled={assistantRuntimeEnabled()}
    />
  );
}
