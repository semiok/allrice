import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { AutomationCatalogTask } from '@allrice/contracts';
import { AutomationTaskCard } from './automation-tasks';

it('renders the authenticated once task content in full with the actual time and timezone', () => {
  const prompt = `${'完整工作内容'.repeat(40)}\n<script>literal task data</script>\n最后一行`;
  const id = '11111111-1111-4111-8111-111111111111';
  const task: AutomationCatalogTask = {
    id,
    name: '提醒',
    prompt,
    employeeId: id,
    employeeName: 'Rice',
    sessionId: id,
    sessionTitle: '安排',
    sourceArchived: false,
    createdAt: '2026-11-03T01:00:00.000Z',
    nextRunAt: '2099-01-01T01:02:03.000Z',
    canStop: true,
    revision: 1,
    definition: {
      kind: 'once',
      task: {
        id,
        clientRequestId: id,
        name: '提醒',
        prompt,
        sessionId: id,
        runAt: '2099-01-01T01:02:03.000Z',
        timezone: 'Asia/Shanghai',
        status: 'pending',
        runId: null,
        errorMessage: null,
        createdAt: '2026-11-03T01:00:00.000Z',
        canCancel: true,
      },
    },
  };
  const html = renderToStaticMarkup(
    <AutomationTaskCard task={task} onOpen={() => {}} />,
  );
  expect(html).toContain('完整工作内容'.repeat(40));
  expect(html).toContain('\n最后一行');
  expect(html).toContain('&lt;script&gt;literal task data&lt;/script&gt;');
  expect(html).not.toContain('<script>');
  expect(html).toContain('2099-01-01T01:02:03.000Z');
  expect(html).toContain('09:02:03');
  expect(html).toContain('Asia/Shanghai');
  expect(html).toContain('打开自动化任务：提醒');
});
