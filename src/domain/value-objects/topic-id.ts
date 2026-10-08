/**
 * A topic is an addressing refinement inside an already-authorized chat, not a security
 * boundary: the ACL stays keyed on ChatId, and a verb granted on a forum chat holds for all its
 * topics. The General topic is virtual — sends into it must omit the topic address.
 */

export const GENERAL_TOPIC_ID = 1;
