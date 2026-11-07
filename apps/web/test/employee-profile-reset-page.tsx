/** Controlled component fixture, not the production employee/reset API path. */
import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { EmployeeInstanceProfileSchema } from '@allrice/contracts';
import {
  EmployeeProfileForm,
  employeeProfileFormFromRaw,
} from '../app/chatflow/employee-profile-form';
import { EmployeeProfileResetDialog } from '../app/chatflow/employee-profile-reset-dialog';
import { setAppearance } from '../lib/theme/appearance';
import { employeeDetailsFixture } from './employee-details-fixture';
import '../app/dsh-upstream/design-platform.css';
import '../app/dsh-upstream/base.css';
import '../app/dsh-upstream/scrollbar.css';
import '@allrice/ui/tokens.css';
import '../app/styles/base.css';
import '@allrice/ui/styles.css';

const params = new URLSearchParams(location.search);
setAppearance(params.get('theme') === 'dark' ? 'dark' : 'light');
const profile = employeeDetailsFixture().profile;
profile.isDefaultRice = true;
profile.editableFields = EmployeeInstanceProfileSchema.keyof().options;
const initialValue = employeeProfileFormFromRaw({}, profile);

function Page() {
  const [phase, setPhase] = useState<
    'confirm' | 'pending' | 'rejected' | 'success' | null
  >(null);
  const [events, setEvents] = useState<string[]>([]);
  const editor = useRef<HTMLElement>(null);
  const exit = (event: string) => {
    setEvents((before) => [...before, event]);
    setPhase(null);
    // This fixture caller owns the editor and its return focus. Production
    // details wiring is deliberately absent while unknown-result copy is open.
    requestAnimationFrame(() => {
      editor.current?.querySelector<HTMLButtonElement>('button')?.focus();
    });
  };
  return (
    <>
      <main
        ref={editor}
        inert={phase !== null}
        style={{ maxWidth: 552, margin: '32px auto', padding: 20 }}
      >
        <EmployeeProfileForm
          mode="edit"
          initialValue={initialValue}
          reset={{ profile, onRequest: () => setPhase('confirm') }}
          onSubmit={() => setEvents((before) => [...before, 'save'])}
          onCancel={() => setEvents((before) => [...before, 'cancel-editor'])}
        />
        <output aria-label="呈现回调记录">{JSON.stringify(events)}</output>
      </main>
      {phase !== null ? (
        <EmployeeProfileResetDialog
          phase={phase}
          onCancel={() => exit('cancel-reset')}
          onReturn={() => exit('return-editor')}
          onConfirm={() => {
            setEvents((before) => [...before, 'confirm-reset']);
            const next = params.get('outcome');
            setPhase(
              next === 'pending'
                ? 'pending'
                : next === 'rejected'
                  ? 'rejected'
                  : 'success',
            );
          }}
        />
      ) : null}
    </>
  );
}

createRoot(document.getElementById('root')!).render(<Page />);
