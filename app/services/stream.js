import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

const DEFAULT_CHUNK = 4 * 1024 * 1024; // 4MB

/**
 * Stream a file with HTTP Range support (206 Partial Content).
 * Handles GET and HEAD requests. Sends 416 on invalid ranges.
 *
 * @param {import('fastify').FastifyRequest} request
 * @param {import('fastify').FastifyReply} reply
 * @param {string} absPath - absolute filesystem path to the file
 * @param {string} mime - MIME type string
 */
export async function sendRangeStream(request, reply, absPath, mime) {
  let fileStat;
  try {
    fileStat = await stat(absPath);
  } catch {
    return reply.code(404).send({ error: 'File not found' });
  }

  const fileSize = fileStat.size;

  // HEAD: just send headers, no body
  if (request.method === 'HEAD') {
    return reply
      .code(200)
      .header('Content-Type', mime)
      .header('Content-Length', fileSize)
      .header('Accept-Ranges', 'bytes')
      .send();
  }

  const rangeHeader = request.headers.range;

  if (!rangeHeader) {
    // No range requested — send full file
    const stream = createReadStream(absPath);
    return reply
      .code(200)
      .header('Content-Type', mime)
      .header('Content-Length', fileSize)
      .header('Accept-Ranges', 'bytes')
      .send(stream);
  }

  // Parse Range header: bytes=start-end
  const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) {
    return reply
      .code(416)
      .header('Content-Range', `bytes */${fileSize}`)
      .send({ error: 'Invalid range' });
  }

  let start = match[1] ? parseInt(match[1], 10) : null;
  let end = match[2] ? parseInt(match[2], 10) : null;

  // Handle suffix range: bytes=-500 (last 500 bytes)
  if (start === null && end !== null) {
    start = Math.max(0, fileSize - end);
    end = fileSize - 1;
  } else if (start !== null && end === null) {
    // Open-ended: bytes=500- (cap to chunk size)
    end = Math.min(start + DEFAULT_CHUNK - 1, fileSize - 1);
  }

  // Validate range
  if (start < 0 || start >= fileSize || end >= fileSize || start > end) {
    return reply
      .code(416)
      .header('Content-Range', `bytes */${fileSize}`)
      .send({ error: 'Range not satisfiable' });
  }

  const contentLength = end - start + 1;
  const stream = createReadStream(absPath, { start, end });

  return reply
    .code(206)
    .header('Content-Type', mime)
    .header('Content-Length', contentLength)
    .header('Content-Range', `bytes ${start}-${end}/${fileSize}`)
    .header('Accept-Ranges', 'bytes')
    .send(stream);
}
