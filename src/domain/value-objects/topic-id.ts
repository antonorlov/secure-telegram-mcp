/**
 * GENERAL_TOPIC_ID — Telegram's fixed id (1) for the virtual General topic of
 * every forum supergroup.
 *
 * A topic is an ADDRESSING REFINEMENT inside an already-authorized chat, not a
 * security boundary: ACL stays keyed on ChatId, and any verb granted on a forum
 * chat holds for all of its topics. The General topic is virtual — its messages
 * carry no reply header, and sends into it must omit the topic address.
 */

/** Telegram's fixed id for the virtual General topic of every forum. */
export const GENERAL_TOPIC_ID = 1;
