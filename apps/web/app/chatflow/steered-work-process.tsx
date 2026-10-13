import type { ComponentProps } from 'react';
import type { ChatFlowEventEnvelope } from '@allrice/contracts';
import { steeringProgress } from '../../lib/chatflow/steering-progress';
import type { Message } from './chatflow-types';
import type { MessageImageSource } from './message-image-cache';
import { WorkProcess } from './work-process';
import { TranscriptUserMessage } from './transcript-user-message';
import styles from './dsh-saas.module.css';
import chatUi from './dsh-upstream/ChatView.module.css';

export function SteeredWorkProcess({
  events,
  messages,
  messageImages,
  employeeName,
  ...props
}: ComponentProps<typeof WorkProcess> & {
  events: ChatFlowEventEnvelope[];
  messages: Message[];
  messageImages?: MessageImageSource;
  employeeName: string;
}) {
  if (!messages.length) return <WorkProcess {...props} />;
  return steeringProgress(
    events,
    messages,
    props.items,
    props.parts,
    props.running,
  ).map((segment) => (
    <div
      key={segment.key}
      data-steering-segment={segment.key}
      data-working={
        (segment.last &&
          props.running &&
          (!props.timing || props.timing.phase === 'active')) ||
        undefined
      }
    >
      {segment.message ? (
        <>
          <div className={chatUi.flowItem} id={`message-${segment.message.id}`}>
            <TranscriptUserMessage
              message={segment.message}
              messageImages={messageImages}
            />
          </div>
          <div className={styles.assistantIdentity}>
            <i aria-hidden="true" />
            <span>{employeeName}</span>
          </div>
        </>
      ) : null}
      <WorkProcess
        {...props}
        items={segment.items}
        parts={segment.parts}
        timing={segment.last ? props.timing : undefined}
        running={segment.last && props.running}
        streaming={segment.last && props.streaming}
        failed={segment.last && props.failed}
        canceled={segment.last && props.canceled}
        failureTitle={segment.last ? props.failureTitle : undefined}
        traceStatus={segment.last ? props.traceStatus : undefined}
        assistantCount={segment.last ? props.assistantCount : 0}
        assistantAttention={segment.last ? props.assistantAttention : 0}
      >
        {segment.last ? props.children : null}
      </WorkProcess>
    </div>
  ));
}
