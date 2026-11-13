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
