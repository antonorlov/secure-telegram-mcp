/**
 * UntrustedText — a Telegram-originated string that must be surfaced to the
 * model only as STRUCTURED JSON under a named key (untrusted_text,
 * sender_display_name, …), NEVER interpolated into prose or instructions, so a
 * hostile message body cannot pose as an instruction. The wrapper is a
 * type-level marker separating trusted strings from sanitized-but-untrusted ones.
 *
 * Construction assumes an ALREADY-SANITIZED string and is reserved for the
 * Sanitizer adapter; the domain never sanitizes, it only carries the result.
 */
/** The named keys under which untrusted text may be surfaced to the model. */
export const UntrustedTextKind = {
  Body: 'untrusted_text',
  SenderDisplayName: 'sender_display_name',
  ChatTitle: 'chat_title',
  MimeType: 'mime_type',
  TopicTitle: 'topic_title',
} as const;

export type UntrustedTextKind =
  (typeof UntrustedTextKind)[keyof typeof UntrustedTextKind];

export class UntrustedText {
  private constructor(
    public readonly kind: UntrustedTextKind,
    public readonly sanitizedValue: string,
  ) {
    Object.freeze(this);
  }

  /** Wrap an ALREADY-SANITIZED string; does not re-sanitize, only labels. */
  public static wrapSanitized(
    kind: UntrustedTextKind,
    sanitizedValue: string,
  ): UntrustedText {
    return new UntrustedText(kind, sanitizedValue);
  }

  /** Structured JSON form — the ONLY sanctioned way to surface this to the model. */
  public toStructured(): Readonly<Record<UntrustedTextKind, string>> {
    return Object.freeze({ [this.kind]: this.sanitizedValue } as Record<
      UntrustedTextKind,
      string
    >);
  }
}
