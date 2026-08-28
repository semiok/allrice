import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

export default async function ChatFlowAdminPage() {
  const host = (await headers()).get('host')?.split(':')[0] ?? '';
  if (host.endsWith('.bplabs.xyz')) {
    redirect('https://allrice-dsh.bplabs.xyz/runtime-console?view=governance');
  }
  if (host.endsWith('.traditionow.ai')) {
    redirect(
      'https://allrice-dsh.traditionow.ai/runtime-console?view=governance',
    );
  }
  redirect('/runtime-console?view=governance');
}
