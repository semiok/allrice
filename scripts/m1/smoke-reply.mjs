import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';

// Runs in the browser through Locator.evaluate. Keep reply evidence inside the
// ChatTranscript message paired with the exact user bubble, never the sidebar.
export function readSmokeReply(transcript, { prompt, marker }) {
  const messages = [...transcript.querySelectorAll('[id^="message-"]')];
  const userIndex = messages.findLastIndex((message) =>
    [...message.querySelectorAll('[class*="userBubble"]')].some(
      (bubble) =>
        bubble.closest('[id^="message-"]') === message &&
        !bubble.closest('[data-process-member]') &&
        bubble.innerText.trim() === prompt.trim(),
    ),
  );
  const visible = (elements) =>
    [...elements].filter((element) => element.getClientRects().length > 0);
  const bodyOf = (message) => {
    // WorkProcess marks earlier reply segments as process members. The final
    // reply stays outside that history; non-parts replies use assistantCopy.
    const bodies = visible(
      message?.querySelectorAll(
        '[data-work-reply]:not([data-process-member]), [class*="assistantCopy"]',
      ) ?? [],
    ).filter((body) => !body.closest('[data-process-member]'));
    return {
      text: bodies.map((body) => body.innerText).join('\n'),
      // AssistantMarkdown adapts authenticated file links to /download?name=
      // <filename>. The visible link label need not contain its extension.
      links: bodies.flatMap((body) =>
        visible(body.querySelectorAll('a[href]')).map((link) =>
          link.getAttribute('href'),
        ),
      ),
    };
  };
  const assistant = userIndex < 0 ? undefined : messages[userIndex + 1];
  const reply = bodyOf(assistant);
  const timing =
    assistant?.querySelector('[aria-label="本轮运行时间"]')?.innerText ?? '';
  // These cards are rendered from this assistant Run's authenticated task IDs.
  // Their state is reminder evidence only, never file-generation evidence.
  const automation = visible(
    assistant?.querySelectorAll('[data-tool="schedule_create"]') ?? [],
  )
    .map((card) => card.innerText)
    .join('\n');
  let delivered = false;
  if (marker && userIndex >= 0) {
    for (let index = userIndex + 2; index + 1 < messages.length; index++) {
      const trigger = messages[index];
      if (
        trigger.querySelector('[data-turn-trigger]') &&
        [...trigger.querySelectorAll('button')].some(
          (button) => button.innerText.trim() === '查看任务',
        ) &&
        bodyOf(messages[index + 1]).text.includes(marker)
      ) {
        delivered = true;
        break;
      }
    }
  }
  return { ...reply, timing, automation, delivered };
}

// CSV only: a native relative Markdown image renders imageAlt, without an img.
// Keep this separate from the shared Office/chat/reminder evidence contract.
export function readSmokeCsvReply(transcript, { prompt }) {
  const messages = [...transcript.querySelectorAll('[id^="message-"]')];
  const index = messages.findLastIndex((message) =>
    [...message.querySelectorAll('[class*="userBubble"]')].some(
      (bubble) =>
        bubble.closest('[id^="message-"]') === message &&
        !bubble.closest('[data-process-member]') &&
        bubble.innerText.trim() === prompt.trim(),
    ),
  );
  const user = messages[index],
    assistant = index < 0 ? null : messages[index + 1];
  const visible = (elements) =>
    [...elements].filter(
      (element) =>
        element.getClientRects().length > 0 &&
        element.closest('[id^="message-"]') === assistant &&
        !element.closest('[data-process-member]'),
    );
  const bodies = visible(
    assistant?.querySelectorAll(
      '[data-work-reply]:not([data-process-member]), [class*="assistantCopy"]',
    ) ?? [],
  );
  const all = (selector) =>
    bodies.flatMap((body) => visible(body.querySelectorAll(selector)));
  return {
    userMessageId: user?.id.slice('message-'.length) ?? null,
    assistantMessageId: assistant?.id.slice('message-'.length) ?? null,
    runId:
      assistant
        ?.querySelector('[data-process-region]')
        ?.getAttribute('data-process-region') ?? null,
    links: all('a[href]').map((link) => ({
      href: link.getAttribute('href'),
      text: link.innerText,
    })),
    images: all('img[src]').map((image) => image.getAttribute('src')),
    captions: all('span[class*="imageAlt"]')
      .filter((span) => !span.closest('pre, code'))
      .map((span) => span.innerText),
  };
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function smokeCsvProofSql({
  sessionId,
  userMessageId,
  assistantMessageId,
  runId,
  prompt,
  account,
}) {
  if (
    ![sessionId, userMessageId, assistantMessageId].every((id) =>
      uuid.test(id ?? ''),
    ) ||
    (runId && !uuid.test(runId)) ||
    !prompt ||
    !account
  )
    throw Error('csv_turn_ids_missing');
  const literal = (value) => `'${value.replaceAll("'", "''")}'`;
  return `select jsonb_build_object(
    'sessionId',er.session_id,'userMessageId',er.user_message_id,'assistantMessageId',er.assistant_message_id,
    'runId',er.run_id,'text',answer.content->>'text','objects',coalesce((
      select jsonb_agg(jsonb_build_object('id',o.id,'runId',a.run_id,'sessionId',v.session_id,
        'mediaType',o.media_type,'sizeBytes',o.size_bytes,'checksum',o.checksum,'state',o.state,
        'immutable',o.immutable,'format',v.format,'fileName',v.file_name))
      from allrice_workbench_artifacts a
      join allrice_deliverable_versions v on v.id=a.version_id and v.organization_id=a.organization_id
        and v.workspace_id=a.workspace_id and v.owner_id=a.owner_id
      join allrice_storage_objects o on o.id=v.object_id and o.organization_id=v.organization_id
        and o.workspace_id=v.workspace_id and o.owner_id=v.owner_id
      join allrice_file_references f on f.object_id=o.id and f.session_id=v.session_id
        and f.organization_id=o.organization_id and f.workspace_id=o.workspace_id and f.owner_id=o.owner_id
      where a.run_id=er.run_id and a.organization_id=er.organization_id and a.workspace_id=er.workspace_id
        and a.owner_id=er.owner_id and v.session_id=er.session_id and v.format='png'
        and o.state='ready' and o.deleted_at is null and o.immutable and o.media_type='image/png'
        and o.category in ('exports','artifacts') and (o.retention_until is null or o.retention_until>clock_timestamp())
    ),'[]'::jsonb)) as proof
    from allrice_employee_runs er
    join allrice_runs r on r.id=er.run_id and r.organization_id=er.organization_id
      and r.workspace_id=er.workspace_id and r.owner_id=er.owner_id
    join allrice_chat_sessions s on s.id=er.session_id and s.organization_id=er.organization_id
      and s.workspace_id=er.workspace_id and s.owner_id=er.owner_id
    join allrice_users u on u.id=er.owner_id
    join allrice_messages question on question.id=er.user_message_id and question.session_id=er.session_id
      and question.organization_id=er.organization_id and question.workspace_id=er.workspace_id and question.owner_id=er.owner_id
    join allrice_messages answer on answer.id=er.assistant_message_id and answer.session_id=er.session_id
      and answer.organization_id=er.organization_id and answer.workspace_id=er.workspace_id and answer.owner_id=er.owner_id
    where er.session_id=${literal(sessionId)} and er.user_message_id=${literal(userMessageId)}
      and er.assistant_message_id=${literal(assistantMessageId)} ${runId ? `and er.run_id=${literal(runId)}` : ''}
      and question.role='user' and question.content->>'text'=${literal(prompt)} and u.username=${literal(account)}
      and er.status='succeeded' and r.state='succeeded' and answer.role='assistant' and answer.status='completed'`;
}

export function readSmokeCsvProof(input) {
  const query = smokeCsvProofSql(input);
  if (!process.env.SMOKE_DATABASE_URL) throw Error('csv_database_unavailable');
  try {
    const output = execFileSync(
      'psql',
      [
        process.env.SMOKE_DATABASE_URL,
        '-XqAt',
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        `begin read only; set local standard_conforming_strings=on; ${query}; commit;`,
      ],
      {
        timeout: 30_000,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${process.env.PATH ?? ''}:/opt/homebrew/bin`,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return output.trim() ? JSON.parse(output) : null;
  } catch {
    // Never echo the database URL, SQL, private final text or psql stderr.
    throw Error('csv_database_proof_unavailable');
  }
}

export function findSmokeCsvDelivery({
  observed,
  proof,
  sessionId,
  base,
  fromMarkdown,
}) {
  if (
    !proof ||
    proof.sessionId !== sessionId ||
    proof.userMessageId !== observed.userMessageId ||
    proof.assistantMessageId !== observed.assistantMessageId ||
    (observed.runId && observed.runId !== proof.runId)
  )
    throw Error('csv_turn_not_confirmed');
  const file = (href) => {
    try {
      const url = new URL(href, base);
      const match = url.pathname.match(
        /^\/api\/v1\/files\/([0-9a-f-]{36})\/download$/,
      );
      return url.origin === new URL(base).origin && match && uuid.test(match[1])
        ? { id: match[1], href: url.href }
        : null;
    } catch {
      return null;
    }
  };
  const root = fromMarkdown(proof.text);
  const definitions = new Map(),
    nodes = [];
  const visit = (node) => {
    if (node.type === 'definition' && !definitions.has(node.identifier))
      definitions.set(node.identifier, node.url);
    if (
      ['link', 'image', 'linkReference', 'imageReference'].includes(node.type)
    )
      nodes.push(node);
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);
  for (const node of nodes) {
    const target = file(node.url ?? definitions.get(node.identifier));
    if (!target) continue;
    const object = proof.objects.find(
      (item) =>
        item.id === target.id &&
        item.runId === proof.runId &&
        item.sessionId === sessionId &&
        item.state === 'ready' &&
        item.immutable &&
        item.format === 'png' &&
        item.mediaType === 'image/png',
    );
    if (!object) continue;
    const image = node.type === 'image' || node.type === 'imageReference';
    // Native reference definitions add the authenticated filename query.
    // Both destinations still require the same-origin file endpoint above.
    const kind = image
      ? observed.images.some((src) => file(src)?.id === target.id)
        ? 'img'
        : node.alt &&
            observed.captions.includes(node.alt) &&
            nodes.filter(
              (entry) =>
                ['image', 'imageReference'].includes(entry.type) &&
                entry.alt === node.alt,
            ).length === 1
          ? 'native-caption'
          : null
      : observed.links.some(
            (link) =>
              file(link.href)?.id === target.id &&
              /\.png(?:$|[?#\s])/i.test(`${link.href}\n${link.text}`),
          )
        ? 'anchor'
        : null;
    if (kind) return { ...target, kind, object };
  }
  throw Error('csv_current_png_delivery_missing');
}

export function validateSmokeCsvPng(bytes, object, mediaType) {
  if (
    object.mediaType !== 'image/png' ||
    mediaType.split(';')[0].trim().toLowerCase() !== 'image/png' ||
    bytes.length !== object.sizeBytes ||
    bytes.length < 45 ||
    bytes.length > 4_000_000 ||
    !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
    `sha256:${createHash('sha256').update(bytes).digest('hex')}` !==
      object.checksum
  )
    throw Error('csv_png_bytes_or_type_invalid');
  let offset = 8,
    width = 0,
    height = 0,
    data = false,
    ended = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset),
      end = offset + 12 + length;
    if (end > bytes.length) throw Error('csv_png_chunk_invalid');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (
      crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)
    )
      throw Error('csv_png_crc_invalid');
    if (offset === 8) {
      if (type !== 'IHDR' || length !== 13)
        throw Error('csv_png_header_invalid');
      width = bytes.readUInt32BE(offset + 8);
      height = bytes.readUInt32BE(offset + 12);
      if (
        !width ||
        !height ||
        width > 8192 ||
        height > 8192 ||
        width * height > 16_000_000
      )
        throw Error('csv_png_dimensions_invalid');
    } else if (type === 'IHDR') throw Error('csv_png_header_invalid');
    if (type === 'IDAT') data = true;
    offset = end;
    if (type === 'IEND') {
      ended = length === 0;
      break;
    }
  }
  if (!ended || !data || offset !== bytes.length)
    throw Error('csv_png_incomplete');
  return { width, height, checksum: object.checksum, sizeBytes: bytes.length };
}

export async function decodeSmokeCsvPng(bytes) {
  const bitmap = await globalThis.createImageBitmap(
    new globalThis.Blob([new globalThis.Uint8Array(bytes)], {
      type: 'image/png',
    }),
  );
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return size;
}
