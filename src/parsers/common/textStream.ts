import { AppError } from '../../models/issues';

export const READ_CHUNK_BYTES = 4 * 1024 * 1024;

function makeDecoder(encoding: string): TextDecoder {
  try {
    return new TextDecoder(encoding || 'utf-8', { fatal: false });
  } catch (e) {
    throw new AppError('UNSUPPORTED_ENCODING', `The text encoding "${encoding}" is not supported by this browser. Choose another encoding (UTF-8, Windows-1252, ...).`, { cause: e });
  }
}

/**
 * Stream a Blob as decoded text chunks without loading the whole file.
 * Blob.slice() + arrayBuffer() works identically in browsers, Web Workers and
 * Node (tests), unlike FileReader. Multi-byte characters split across chunk
 * boundaries are handled by TextDecoder's streaming mode.
 */
export async function* readTextChunks(
  blob: Blob,
  encoding: string,
  onBytes?: (bytesRead: number) => void,
  chunkBytes = READ_CHUNK_BYTES,
): AsyncGenerator<string> {
  const decoder = makeDecoder(encoding);
  let offset = 0;
  while (offset < blob.size) {
    const end = Math.min(blob.size, offset + chunkBytes);
    const buf = await blob.slice(offset, end).arrayBuffer();
    offset = end;
    const text = decoder.decode(new Uint8Array(buf), { stream: offset < blob.size });
    onBytes?.(offset);
    if (text) yield text;
  }
  const tail = decoder.decode();
  if (tail) yield tail;
}

/** Decode the whole Blob to one string (JSON / XML). */
export async function readAllText(blob: Blob, encoding: string, onBytes?: (bytesRead: number) => void): Promise<string> {
  const parts: string[] = [];
  for await (const chunk of readTextChunks(blob, encoding, onBytes)) parts.push(chunk);
  try {
    return parts.join('');
  } catch (e) {
    throw new AppError(
      'FILE_TOO_LARGE',
      'This file is too large to be held as a single text document in the browser. For JSON, use JSON Lines (one record per line); for other formats, split the file.',
      { cause: e },
    );
  }
}

/** Read the first `bytes` of a Blob as text (for detection and previews). */
export async function readTextHead(blob: Blob, encoding: string, bytes = 256 * 1024): Promise<string> {
  const buf = await blob.slice(0, Math.min(bytes, blob.size)).arrayBuffer();
  return makeDecoder(encoding).decode(new Uint8Array(buf), { stream: true });
}

/** Split the start of a text into lines (for previews and sniffing). */
export function headLines(text: string, max = 50): string[] {
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.length > 1) lines.pop(); // last line may be cut mid-way
  return lines.slice(0, max);
}
