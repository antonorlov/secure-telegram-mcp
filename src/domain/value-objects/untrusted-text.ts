/**
 * A Telegram-originated string that may reach the model only as structured JSON under a named
 * key, never interpolated into prose, so a hostile message body cannot pose as an instruction.
 * Construction assumes an already-sanitized string and is reserved for the Sanitizer adapter.
 */
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

  // Labels only — does not re-sanitize.
  public static wrapSanitized(
    kind: UntrustedTextKind,
    sanitizedValue: string,
  ): UntrustedText {
    return new UntrustedText(kind, sanitizedValue);
  }

  // The only sanctioned way to surface this to the model.
  public toStructured(): Readonly<Record<UntrustedTextKind, string>> {
    return Object.freeze({ [this.kind]: this.sanitizedValue } as Record<
      UntrustedTextKind,
      string
    >);
  }
}
