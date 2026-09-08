import { ChatFlowClient } from './chatflow-client';
import { localCommandFeatureEnabled } from '@allrice/database';

export const dynamic = 'force-dynamic';

export default function ChatFlowPage() {
  return (
    <ChatFlowClient
      workbenchEnabled={process.env.ALLRICE_WORKBENCH_ENABLED === '1'}
      localCommandsEnabled={localCommandFeatureEnabled()}
    />
  );
}
