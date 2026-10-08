// A topic is an addressing refinement inside an already-authorized forum supergroup — never a
// security principal, so the ACL stays keyed on the chat.
import type { UntrustedText } from '../../domain/index.js';

export interface TopicDto {
  // Topic root message id; 1 = the virtual General topic.
  readonly topicId: number;
  readonly title: UntrustedText;
  readonly unreadCount: number;
  readonly closed: boolean;
  readonly pinned: boolean;
  readonly lastMessageId: number;
}
