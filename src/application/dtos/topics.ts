/**
 * Forum-topic read DTOs. A topic is an addressing refinement inside an
 * already-authorized forum supergroup — never a security principal (ACL stays
 * keyed on the chat). Untrusted titles carried as UntrustedText.
 */
import type { UntrustedText } from '../../domain/index.js';

export interface TopicDto {
  /** Topic root message id within the chat; 1 = the virtual General topic. */
  readonly topicId: number;
  readonly title: UntrustedText;
  readonly unreadCount: number;
  readonly closed: boolean;
  readonly pinned: boolean;
  /** Id of the most recent message in the topic. */
  readonly lastMessageId: number;
}
