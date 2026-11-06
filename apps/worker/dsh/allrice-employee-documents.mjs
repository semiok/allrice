import { PERSONA_PREFIX_SECTION } from '@deepseek-ai/dsh-system-prompt';
import { EmployeeDocumentsSchema } from '@allrice/contracts/native-runtime';

/** Public exact-Agent context reads the admitted Run's frozen documents.
 * Only root shadows the deployment persona and receives USER/MEMORY. Native
 * child persona, composition, history, approvals and context snapshots remain. */
export function installEmployeeDocuments(host, rootPersona) {
  const registrations = new WeakMap();
  function register(agent, root, state) {
    if (registrations.has(agent)) return;
    const assertCurrent = () => {
      host.assertRoot(host.requireRoot(root.id), root.id);
      if (host.runAdmission.rootFor(agent) !== root)
        throw Error('EMPLOYEE_DOCUMENT_ROOT_REQUIRED');
    };
    if (agent === root)
      agent.ctx.systemPrompt.section({
        name: PERSONA_PREFIX_SECTION,
        order: agent.ctx.systemPrompt.getSectionOrder(
          'DEPLOYMENT_PERSONA_PREFIX',
        ),
        // Retain the deployment persona's native interpolation behavior.
        text: () => {
          assertCurrent();
          return rootPersona;
        },
      });
    agent.ctx.systemPrompt.context({
      name: 'allrice:employee-documents',
      order: 100,
      required: true,
      interpolate: false,
      text: () => {
        assertCurrent();
        return agent === root
          ? [
              state.documents.persona,
              state.documents.user,
              state.documents.memory,
            ]
              .filter(Boolean)
              .join('\n\n')
          : (state.documents.persona ?? '');
      },
    });
    registrations.set(agent, state);
  }
  return {
    bind(sessionId, input) {
      const { agent } = host.requireRoot(sessionId);
      if (host.runAdmission.rootFor(agent) !== agent)
        throw Error('EMPLOYEE_DOCUMENT_ROOT_REQUIRED');
      const documents = EmployeeDocumentsSchema.parse(
        input ?? { user: '', memory: '' },
      );
      let state = registrations.get(agent);
      if (!state) {
        state = { documents };
        register(agent, agent, state);
      }
      state.documents = documents;
      for (const child of host.ctx.agents.list()) {
        if (child === agent) continue;
        if (host.runAdmission.rootFor(child) !== agent)
          throw Error('EMPLOYEE_DOCUMENT_ROOT_REQUIRED');
        register(child, agent, state);
      }
    },
    // Called only after the existing created-event ownership/cwd admission.
    // The identity announcement follows creation; the provider checks live
    // admission when DSH actually materializes the current context.
    bindChild(agent, root) {
      const state = registrations.get(root);
      if (!state) throw Error('EMPLOYEE_DOCUMENT_ROOT_REQUIRED');
      register(agent, root, state);
    },
  };
}
