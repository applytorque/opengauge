import path from 'path';
import { compressPrompt } from '../optimizer/compressor';

export interface UploadedAttachment {
  filename: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
}

export interface ProcessedAttachment {
  filename: string;
  mimetype: string;
  size: number;
  kind: 'pdf' | 'image' | 'text' | 'binary';
  extractedText: string;
  summary: string;
  keyPoints: string[];
  chunks: string[];
}

export interface AttachmentProcessResult {
  files: ProcessedAttachment[];
  inlineContext: string;
  count: number;
}

const MAX_FILES = 8;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_CHARS_PER_FILE = 20000;
const MAX_TOTAL_CONTEXT_CHARS = 22000;
const CHUNK_SIZE = 1200;
const CHUNK_OVERLAP = 180;

export async function processAttachments(
  files: UploadedAttachment[]
): Promise<AttachmentProcessResult | null> {
  if (!files.length) return null;

  const limitedFiles = files.slice(0, MAX_FILES);
  const processed: ProcessedAttachment[] = [];
  const sections: string[] = [];
  let totalChars = 0;

  for (const file of limitedFiles) {
    const result = await processSingleAttachment(file);
    if (!result) continue;

    processed.push(result);

    const keyPointsText = result.keyPoints.map((point, i) => `${i + 1}. ${point}`).join('\n');
    const section = `[File: ${result.filename}]\nType: ${result.kind} (${result.mimetype || 'unknown'})\nSummary: ${result.summary}\nKey Points:\n${keyPointsText}`;

    if (totalChars + section.length <= MAX_TOTAL_CONTEXT_CHARS) {
      sections.push(section);
      totalChars += section.length;
    }
  }

  if (!processed.length) return null;

  const combined = `[Attached Files]\nUse this processed file context when answering. Prioritize user message when conflicts occur.\n\n${sections.join('\n\n')}\n\n[End Attached Files]`;
  const compressed = compressPrompt(combined, 0.7).compressed;

  return {
    files: processed,
    inlineContext: compressed,
    count: processed.length,
  };
}

async function processSingleAttachment(file: UploadedAttachment): Promise<ProcessedAttachment | null> {
  const ext = path.extname(file.filename).toLowerCase();
  const mime = (file.mimetype || '').toLowerCase();
  const safeName = file.filename || 'unnamed-file';

  if (file.size > MAX_FILE_BYTES) {
    const summary = `File skipped due to size limit (${file.size} bytes).`;
    return {
      filename: safeName,
      mimetype: mime,
      size: file.size,
      kind: inferKind(mime, ext),
      extractedText: summary,
      summary,
      keyPoints: [summary],
      chunks: [summary],
    };
  }

  const kind = inferKind(mime, ext);
  let text = '';

  if (kind === 'pdf') {
    text = await extractPdfText(file.buffer);
    if (!text) {
      text = 'PDF detected but text extraction returned empty. The file may be scanned or image-based.';
    }
  } else if (kind === 'text') {
    text = file.buffer.toString('utf8');
  } else if (kind === 'image') {
    text = await extractImageTextWithOptionalOCR(file.buffer);
    if (!text) {
      text = `Image attached (${safeName}). OCR is not available in this runtime, so only metadata is stored.`;
    }
  } else {
    const headerHex = file.buffer.subarray(0, 64).toString('hex');
    text = `Binary file attached (${safeName}). Full parser not available for this type. Size: ${file.size} bytes. Header(hex): ${headerHex}`;
  }

  const normalized = normalizeText(text).slice(0, MAX_TEXT_CHARS_PER_FILE);
  const chunks = chunkText(normalized, CHUNK_SIZE, CHUNK_OVERLAP);
  const { summary, keyPoints } = summarizeTextIntelligently(normalized);

  return {
    filename: safeName,
    mimetype: mime,
    size: file.size,
    kind,
    extractedText: normalized,
    summary,
    keyPoints,
    chunks,
  };
}

function inferKind(mime: string, ext: string): 'pdf' | 'image' | 'text' | 'binary' {
  if (mime.includes('pdf') || ext === '.pdf') return 'pdf';
  if (mime.startsWith('image/')) return 'image';
  if (isTextLike(mime, ext)) return 'text';
  return 'binary';
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  try {
    const pdfParseModule = await import('pdf-parse');
    const pdfParse = (pdfParseModule as any).default || pdfParseModule;
    const result = await pdfParse(buffer);
    return result?.text || '';
  } catch {
    return '';
  }
}

async function extractImageTextWithOptionalOCR(_buffer: Buffer): Promise<string> {
  try {
    const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
    const tesseract = await dynamicImport('tesseract.js');

    const createWorker = tesseract.createWorker || tesseract.default?.createWorker;
    if (!createWorker) return '';

    const worker = await createWorker('eng');
    const result = await worker.recognize(_buffer);
    await worker.terminate();

    return normalizeText(result?.data?.text || '');
  } catch {
    return '';
  }
}

function isTextLike(mime: string, ext: string): boolean {
  if (mime.startsWith('text/')) return true;
  if (mime.includes('json') || mime.includes('xml') || mime.includes('yaml') || mime.includes('csv')) {
    return true;
  }

  const textExtensions = new Set([
    '.txt', '.md', '.markdown', '.json', '.yaml', '.yml', '.xml', '.csv', '.ts', '.js', '.jsx', '.tsx',
    '.py', '.java', '.c', '.cpp', '.cs', '.go', '.rs', '.rb', '.php', '.swift', '.kt', '.sql', '.html',
    '.css', '.scss', '.sh', '.bash', '.zsh', '.toml', '.ini', '.cfg', '.conf', '.log', '.rtf'
  ]);

  return textExtensions.has(ext);
}

function normalizeText(text: string): string {
  return text
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ')
    .trim();
}

function chunkText(text: string, chunkSize: number, overlap: number): string[] {
  if (!text) return [];
  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + chunkSize, text.length);

    if (end < text.length) {
      const boundary = text.lastIndexOf('\n', end);
      const sentenceBoundary = text.lastIndexOf('. ', end);
      const bestBoundary = Math.max(boundary, sentenceBoundary);
      if (bestBoundary > start + Math.floor(chunkSize * 0.5)) {
        end = bestBoundary + 1;
      }
    }

    const chunk = text.slice(start, end).trim();
    if (chunk) chunks.push(chunk);

    if (end >= text.length) break;
    start = Math.max(end - overlap, start + 1);
  }

  return chunks.slice(0, 30);
}

function summarizeTextIntelligently(text: string): { summary: string; keyPoints: string[] } {
  if (!text) {
    return { summary: 'No extractable text content found.', keyPoints: ['No text content available.'] };
  }

  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 20 && s.length < 320)
    .slice(0, 200);

  if (sentences.length === 0) {
    const snippet = text.slice(0, 240);
    return { summary: snippet, keyPoints: [snippet] };
  }

  const stopwords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'to', 'of', 'and', 'in', 'on',
    'for', 'with', 'as', 'by', 'at', 'from', 'or', 'that', 'this', 'it', 'its', 'if', 'then', 'than',
    'into', 'about', 'over', 'under', 'between', 'after', 'before', 'can', 'could', 'should', 'would',
    'may', 'might', 'will', 'shall', 'do', 'does', 'did', 'not', 'no', 'yes', 'we', 'you', 'they'
  ]);

  const freq = new Map<string, number>();
  for (const sentence of sentences) {
    const words = sentence.toLowerCase().match(/[a-z0-9]{3,}/g) || [];
    for (const word of words) {
      if (stopwords.has(word)) continue;
      freq.set(word, (freq.get(word) || 0) + 1);
    }
  }

  const scored = sentences.map((sentence) => {
    const words = sentence.toLowerCase().match(/[a-z0-9]{3,}/g) || [];
    const score = words.reduce((sum, word) => sum + (freq.get(word) || 0), 0) / Math.max(words.length, 1);
    return { sentence, score };
  });

  const top = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map((s) => s.sentence);

  const keyPoints = top.slice(0, 5);
  const summary = compressPrompt(top.slice(0, 3).join(' '), 0.55).compressed;

  return {
    summary,
    keyPoints: keyPoints.length ? keyPoints : [summary],
  };
}
