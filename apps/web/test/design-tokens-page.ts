// Every stylesheet the root layout loads, in its order, so a conflicting
// declaration anywhere would show up here.
import '../app/dsh-upstream/design-platform.css';
import '../app/dsh-upstream/base.css';
import '../app/dsh-upstream/scrollbar.css';
import '@allrice/ui/tokens.css';
import '../app/styles/base.css';
import '../app/styles/auth.css';
import '@allrice/ui/styles.css';

const probe = document.createElement('p');
probe.id = 'probe';
probe.textContent = '与 Rice 工作';
document.body.append(probe);
