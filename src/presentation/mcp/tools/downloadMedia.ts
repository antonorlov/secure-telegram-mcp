/**
 * `download_media` — media EGRESS behind its own verb (`read_media`).
 *
 * Presentation only: it maps args -> a `DownloadMediaQuery` and shapes the use-case's
 * `MediaFileDto`. All load-bearing behaviour (the read_media ACL gate, the declared-size
 * cap check BEFORE download, the confined server-generated path, and the SUCCESS audit
 * attempt) lives in the injected use-case + gateway; this handler never touches Telegram
 * or the filesystem. Bytes never cross the boundary — only the written file path + metadata.
 */
import type { z } from 'zod';
import { ok } from '../../../shared/index.js';
import type {
  DownloadMediaQuery,
  MediaFileDto,
  UseCase,
} from '../../../application/index.js';
import type { ToolDefinition } from '../registry.js';
import { peerRefSchema, messageIdSchema } from '../schemas/primitives.js';
import { mediaFileOutputShape, presentMediaFile } from '../schemas/outputs.js';
import { defineTool } from './define-tool.js';

const downloadMediaInputShape = {
  peer: peerRefSchema,
  messageId: messageIdSchema,
} satisfies z.ZodRawShape;

export const createDownloadMediaTool = (
  useCase: UseCase<DownloadMediaQuery, MediaFileDto>,
): ToolDefinition<typeof downloadMediaInputShape> =>
  defineTool({
    name: 'download_media',
    title: 'Download message media',
    description:
      'Download the media attached to a single in-scope message to a server-chosen ' +
      'file inside the allow-listed media directory, returning the file path (NOT the ' +
      'bytes). Requires the read_media grant — a text-only endpoint is refused. Media ' +
      'larger than the configured download cap is refused before any bytes are fetched. ' +
      'Every successful download submits an audit record; a sink failure is reported by ' +
      'the service but does not remove the downloaded file. The original file name is ' +
      'untrusted and surfaced under a named key, never as a bare instruction-bearing string.',
    inputShape: downloadMediaInputShape,
    outputShape: mediaFileOutputShape,
    useCase,
    present: (dto) => ok({ structured: presentMediaFile(dto) }),
  });
