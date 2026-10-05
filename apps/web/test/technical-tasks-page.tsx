import { createRoot } from 'react-dom/client';
import { TechnicalTasks } from '../app/runtime-console/technical-tasks';

createRoot(document.getElementById('root')!).render(
  <TechnicalTasks issueId={null} />,
);
