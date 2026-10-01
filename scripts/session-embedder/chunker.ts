export interface TextChunk {
  text: string;
  index: number;
}

export interface ChunkingOptions {
  maxChunkSize?: number;
  overlap?: number;
  minChunkSize?: number;
  splitOn?: string[];
}

export class SessionChunker {
  private options: Required<ChunkingOptions>;

  constructor(options: ChunkingOptions = {}) {
    this.options = {
      maxChunkSize: options.maxChunkSize ?? 1500,
      overlap: options.overlap ?? 200,
      minChunkSize: options.minChunkSize ?? 100,
      splitOn: options.splitOn ?? ['\n\n', '\n', '. ', '! ', '? '],
    };
  }

  chunk(text: string): TextChunk[] {
    if (text.length <= this.options.maxChunkSize) {
      return [{ text, index: 0 }];
    }

    const chunks: TextChunk[] = [];
    let startIndex = 0;
    let chunkIndex = 0;

    while (startIndex < text.length) {
      const endIndex = Math.min(startIndex + this.options.maxChunkSize, text.length);
      let chunkEnd = endIndex;

      if (endIndex < text.length) {
        chunkEnd = this.findBestSplitPoint(text, startIndex, endIndex);
      }

      const chunkText = text.substring(startIndex, chunkEnd).trim();

      if (chunkText.length >= this.options.minChunkSize) {
        chunks.push({ text: chunkText, index: chunkIndex++ });
      }

      startIndex = Math.max(chunkEnd - this.options.overlap, startIndex + 1);

      if (startIndex >= chunkEnd) {
        startIndex = chunkEnd;
      }
    }

    return chunks;
  }

  private findBestSplitPoint(text: string, start: number, maxEnd: number): number {
    for (const delimiter of this.options.splitOn) {
      const searchStart = maxEnd - Math.min(200, maxEnd - start);
      const lastIndex = text.lastIndexOf(delimiter, maxEnd);

      if (lastIndex > searchStart) {
        return lastIndex + delimiter.length;
      }
    }

    return maxEnd;
  }

  chunkSession(sessionContent: string): TextChunk[] {
    const cleaned = this.cleanSessionContent(sessionContent);
    return this.chunk(cleaned);
  }

  private cleanSessionContent(content: string): string {
    let cleaned = content.replace(/\n{3,}/g, '\n\n');
    cleaned = cleaned.replace(/^\s*\[\d{4}-\d{2}-\d{2}.*?\]\s*/gm, '');
    cleaned = cleaned.split('\n').map(line => line.trim()).join('\n');
    cleaned = cleaned.replace(/ {2,}/g, ' ');
    return cleaned.trim();
  }
}
