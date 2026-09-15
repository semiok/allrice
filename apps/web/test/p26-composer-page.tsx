// Isolated real React/Chromium fixture. Not a Next route, auth bypass, or model test.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatFlowClient } from '../app/chatflow/chatflow-client';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ChatFlowClient workbenchEnabled assistantsEnabled />
  </StrictMode>,
);
