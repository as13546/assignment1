import fs from 'node:fs';

/**
 * Splits a byte stream into lines, taking the encoding from the BOM: PowerShell
 * `claude ... > events.jsonl` writes UTF-16LE. Splitting on bytes means a
 * multi-byte character is never cut in half.
 */
export class LineDecoder {
  private buf: Buffer = Buffer.alloc(0);
  private enc: 'utf8' | 'utf16le' = 'utf8';
  private decided = false;

  push(chunk: Buffer): string[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;

    if (!this.decided) {
      if (this.buf.length >= 2 && this.buf[0] === 0xff && this.buf[1] === 0xfe) {
        this.enc = 'utf16le';
        this.buf = this.buf.subarray(2);
        this.decided = true;
      } else if (this.buf.length >= 3 && this.buf[0] === 0xef && this.buf[1] === 0xbb && this.buf[2] === 0xbf) {
        this.buf = this.buf.subarray(3);
        this.decided = true;
      } else if (this.buf.length >= 1) {
        this.decided = true;
      }
    }

    const lines: string[] = [];
    let start = 0;
    for (let i = 0; i < this.buf.length; i++) {
      if (this.enc === 'utf8') {
        if (this.buf[i] !== 0x0a) continue;
        lines.push(this.decode(this.buf.subarray(start, i)));
        start = i + 1;
      } else {
        if (this.buf[i] !== 0x0a || this.buf[i + 1] !== 0x00) continue;
        lines.push(this.decode(this.buf.subarray(start, i)));
        start = i + 2;
        i++;
      }
    }
    this.buf = this.buf.subarray(start);
    return lines.map((l) => l.replace(/\r$/, '')).filter((l) => l.length > 0);
  }

  /** Anything left after the stream closed (a file with no trailing newline). */
  flush(): string[] {
    const rest = this.decode(this.buf).replace(/\r?\n?$/, '');
    this.buf = Buffer.alloc(0);
    return rest ? [rest] : [];
  }

  private decode(bytes: Buffer): string {
    // Buffer.toString('utf16le') needs an even byte count; a trailing newline
    // byte-pair is already stripped, but be defensive about odd leftovers.
    if (this.enc === 'utf16le') {
      const even = bytes.length % 2 === 0 ? bytes : bytes.subarray(0, bytes.length - 1);
      return even.toString('utf16le');
    }
    return bytes.toString('utf8');
  }

  get encoding(): 'utf8' | 'utf16le' {
    return this.enc;
  }
}

export function readEventFile(file: string): string[] {
  const bytes = fs.readFileSync(file);
  const decoder = new LineDecoder();
  return [...decoder.push(bytes), ...decoder.flush()];
}

/** How many records a JSONL file holds, used to pace a long replay. */
export function countLines(file: string): number {
  try {
    const bytes = fs.readFileSync(file);
    let count = 0;
    for (const byte of bytes) if (byte === 0x0a) count += 1;
    // A file with no trailing newline still has one more record.
    return bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a ? count + 1 : count;
  } catch {
    return 0;
  }
}

/** Yield the lines of a JSONL file without holding the whole file in memory. */
export async function* readLines(file: string): AsyncGenerator<string> {
  const decoder = new LineDecoder();
  const stream = fs.createReadStream(file);
  try {
    for await (const chunk of stream) {
      for (const line of decoder.push(Buffer.from(chunk))) yield line;
    }
    for (const line of decoder.flush()) yield line;
  } finally {
    stream.destroy();
  }
}
