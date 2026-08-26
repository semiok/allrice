import { redirect } from 'next/navigation';

import { ChatFlowClient } from './chatflow-client';

export const dynamic = 'force-dynamic';

export default function ChatFlowPage() {
  if (process.env.ALLRICE_CHATFLOW_V2_ENABLED === '0') redirect('/workspace');
  return <ChatFlowClient />;
}
