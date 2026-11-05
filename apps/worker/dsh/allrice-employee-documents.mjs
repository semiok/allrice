import { PERSONA_PREFIX_SECTION } from '@deepseek-ai/dsh-system-prompt';
import { EmployeeDocumentsSchema } from '@allrice/contracts/native-runtime';

/** Public exact-Agent scope shadows only root's deployment persona. Native
 * child composition/fork/history/approvals are untouched. Native context owns
 * snapshot equality, durable updates, CLEARED and cold resume. */
export function installEmployeeDocuments(host, rootPersona) {
  const registrations = new WeakMap();
  return {
    bind(sessionId, input) {
      const { agent } = host.requireRoot(sessionId);
      if (host.runAdmission.rootFor(agent) !== agent)
        throw Error('EMPLOYEE_DOCUMENT_ROOT_REQUIRED');
      const documents = EmployeeDocumentsSchema.parse(input ?? { user: '', memory: '' });
      let state = registrations.get(agent);
      if (!state) {
        state = { documents };
        const current = state;
        const assertRoot = () => {
          host.assertRoot(host.requireRoot(sessionId), sessionId);
          if (host.runAdmission.rootFor(agent) !== agent)
            throw Error('EMPLOYEE_DOCUMENT_ROOT_REQUIRED');
        };
        agent.ctx.systemPrompt.section({
          name: PERSONA_PREFIX_SECTION,
          order: agent.ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
          // Retain the deployment persona's native interpolation behavior.
          text: () => { assertRoot(); return rootPersona; },
        });
        agent.ctx.systemPrompt.context({
          name: 'allrice:employee-documents', order: 100,
          required: true, interpolate: false,
          text: () => {
            assertRoot();
            return [current.documents.user, current.documents.memory].filter(Boolean).join('\n\n');
          },
        });
        registrations.set(agent, state);
      }
      state.documents = documents;
    },
  };
}
