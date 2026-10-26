// The stylesheets that define the theme on every page, in root-layout order.
import '../app/dsh-upstream/design-platform.css';
import '../app/dsh-upstream/base.css';
import '@allrice/ui/tokens.css';

const probe = document.createElement('p');
probe.id = 'probe';
probe.textContent = '与 Rice 工作';
probe.style.cssText =
  'background: var(--ar-surface-raised); color: var(--ar-text); font: var(--ar-font-body); border-radius: var(--ar-radius-md); box-shadow: var(--ar-shadow-1); padding: var(--ar-space-4)';
document.body.append(probe);
