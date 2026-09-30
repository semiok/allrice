// Isolated real React/Chromium fixture. Not a Next route, auth bypass, or model test.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatFlowClient } from '../app/chatflow/chatflow-client';
import '../app/dsh-upstream/design-platform.css';
import '../app/dsh-upstream/base.css';
import '../app/dsh-upstream/scrollbar.css';
import '../app/styles/base.css';
import '@allrice/ui/styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ChatFlowClient workbenchEnabled assistantsEnabled experienceEnabled />
  </StrictMode>,
);
