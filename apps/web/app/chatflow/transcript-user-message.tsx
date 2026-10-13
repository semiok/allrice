import type { Message } from './chatflow-types';
import type { MessageImageSource } from './message-image-cache';
import { MessageImageGallery } from './attachment-components';
import { SessionReferenceChips } from './session-reference-picker';
import { UserQuestionReceipt } from './user-question-receipt';
import { MessageIconActions } from './dsh-upstream/feedback/MessageIconActions';
import { feedbackTranslate } from './feedback-labels';
import messageUi from './dsh-upstream/MessageItem.module.css';
import styles from './dsh-saas.module.css';
export function TranscriptUserMessage({
  message,
  messageImages,
}: {
  message: Message;
  messageImages?: MessageImageSource;
}) {
  return (
    <>
      {message.role === 'user' &&
      message.content.interaction?.type === 'user_question_answer' ? (
        <UserQuestionReceipt
          answer={message.content.interaction.answer}
          createdAt={message.createdAt}
          text={message.content.text}
        />
      ) : message.role === 'user' &&
        message.content.interaction?.type === 'changeset_request' ? (
        <div className={styles.messageMeta}>
          <strong>
            文件
            {message.content.interaction.action.restoreOf ? '恢复' : '应用'}
            请求 · 尚未授权执行
          </strong>
          <details>
            <summary>查看请求</summary>
            <p>{message.content.text}</p>
          </details>
        </div>
      ) : message.role === 'user' &&
        message.content.interaction?.type === 'review_response' ? (
        <div className={styles.messageMeta}>
          <strong>
            {message.content.interaction.review.kind === 'plan_review'
              ? '计划已认可 · 不代表动作批准'
              : '版本修订请求'}
          </strong>
          <span>
            版本 {message.content.interaction.review.artifactId.slice(0, 8)}
          </span>
          <details>
            <summary>查看提交内容</summary>
            <p>{message.content.text}</p>
          </details>
        </div>
      ) : message.role === 'user' ? (
        <div className={messageUi.userRow} data-actions-reveal="hover">
          <div className={messageUi.userStack}>
            <SessionReferenceChips
              references={message.content.sessionReferences ?? []}
            />
            {message.content.companyAssets &&
              (message.content.companyAssets.rules.length > 0 ||
                message.content.companyAssets.templates.length > 0) && (
                <details aria-label="本次采用的公司资料">
                  <summary>
                    本次公司资料 · {message.content.companyAssets.rules.length}{' '}
                    条规矩 · {message.content.companyAssets.templates.length}{' '}
                    项范本
                  </summary>
                  {message.content.companyAssets.rules.map((ref) => (
                    <p key={ref.assetId}>
                      规矩：{ref.revision.content.title} · v
                      {ref.revision.number}
                    </p>
                  ))}
                  {message.content.companyAssets.templates.map((ref) => (
                    <div key={ref.assetId}>
                      <p>
                        范本：{ref.revision.content.title} · v
                        {ref.revision.number}
                      </p>
                      {ref.revision.content.slots.map((slot) => (
                        <p key={slot.key}>
                          {slot.label}：{ref.parameters[slot.key] || '未填写'}
                        </p>
                      ))}
                    </div>
                  ))}
                </details>
              )}
            {messageImages && message.attachments?.length ? (
              <MessageImageGallery
                attachments={message.attachments}
                source={messageImages}
              />
            ) : null}
            <div className={`${messageUi.bubble} ${styles.userBubble}`}>
              {message.content.text}
            </div>
            {message.steering ? (
              <small className={styles.messageMeta} role="status">
                {
                  {
                    pending: '等待当前任务采纳',
                    adopted: '已补充到当前任务',
                    rejected: '补充未被采纳',
                    unknown: '补充状态待确认',
                  }[message.steering.status]
                }
              </small>
            ) : null}
          </div>
          <MessageIconActions
            text={message.content.text}
            time={Date.parse(message.createdAt)}
            clock="start"
            t={feedbackTranslate}
          />
        </div>
      ) : null}
    </>
  );
}
