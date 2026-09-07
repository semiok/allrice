// Real Chrome acceptance entry, not a product route.
import { createRoot } from 'react-dom/client';
import { ChangesetPanel } from '../app/chatflow/changeset-panel';
const props = JSON.parse(document.getElementById('p08-input')!.textContent!);
createRoot(document.getElementById('root')!).render(
  <ChangesetPanel {...props} />,
);
