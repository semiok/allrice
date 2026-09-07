import { ChatFlowClient } from './chatflow-client';

export const dynamic = 'force-dynamic';

export default function ChatFlowPage() {
  return (
    <ChatFlowClient
      workbenchEnabled={process.env.ALLRICE_WORKBENCH_ENABLED === '1'}
    />
  );
}
