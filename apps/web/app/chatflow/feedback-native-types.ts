/** Structural host boundary for the unchanged DSH feedback controllers/views. */
import type {
  FeedbackCategory,
  MessageFeedbackItem,
  MessageFeedbackResult,
} from '@allrice/contracts';
import type {
  MessageFeedbackActionResult,
  MessageFeedbackView,
} from './dsh-upstream/feedback/controller';
import type { FeedbackDialogState } from './dsh-upstream/feedback/dialog';
export type { FeedbackCategory, MessageFeedbackItem };
export type MessageId = string;
export type SessionId = string;
export type MessageFeedbackRating = 'positive' | 'negative';
export type FeedbackRecord = { text?: string; category?: FeedbackCategory };
export type Translate<K extends string = string> = (
  key: K,
  params?: Record<string, string | number>,
) => string;
export type ChatViewSlotProps = { t: Translate };
export interface HostObservable<T> {
  getSnapshot: () => T;
  subscribe: (listener: () => void) => () => void;
}
type Carrier<T> =
  | { ok: true; value: MessageFeedbackResult<T> }
  | { ok: false; error: { code: string; message: string } };
export interface ClientRemote {
  messageFeedback: {
    list: (input: {
      sessionId: string;
    }) => Promise<Carrier<{ items: MessageFeedbackItem[] }>>;
    put: (input: {
      sessionId: string;
      messageId: string;
      rating: MessageFeedbackRating;
      note?: string;
      category?: FeedbackCategory;
      ifVersion: string | null;
    }) => Promise<Carrier<MessageFeedbackItem>>;
    delete: (input: {
      sessionId: string;
      messageId: string;
      ifVersion: string;
    }) => Promise<Carrier<{ absent: true }>>;
  };
}
type Hook<T> = <R>(selector: (value: T) => R) => R;
export interface MessageFeedbackActionProps {
  messageId: string;
  t: Translate;
  useFeedback: Hook<MessageFeedbackView>;
  ensure: () => Promise<MessageFeedbackActionResult>;
  current: (messageId: string) => MessageFeedbackItem | undefined;
  retract: (
    messageId: string,
    rating: MessageFeedbackRating,
  ) => Promise<MessageFeedbackActionResult>;
  openDialog: (messageId: string, rating: MessageFeedbackRating) => void;
}
export interface FeedbackDialogProps {
  useDialog: Hook<FeedbackDialogState>;
  t: Translate;
  edit: (
    draft: Partial<Pick<FeedbackDialogState, 'category' | 'text'>>,
  ) => void;
  submit: () => Promise<void>;
  dismiss: () => void;
  dismissFailure: () => void;
  dismissToast: (sequence: number) => void;
}
