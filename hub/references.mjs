import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
export const MAX_TEXT = 200_000;

export async function parseReferences(files) {
  if (!Array.isArray(files) || files.length > 8) throw new Error('Choose up to eight documents.');
  let bytes = 0, characters = 0;
  const documents = [];
  for (const file of files) {
    if (typeof file?.name !== 'string' || typeof file?.data !== 'string') throw new Error('Invalid document upload.');
    const name = file.name.split(/[\\/]/).at(-1).slice(0, 160);
    const extension = extname(name).toLowerCase();
    if (!['.txt', '.md', '.pdf', '.docx'].includes(extension)) throw new Error(`${name}: use TXT, Markdown, PDF or DOCX.`);
    const buffer = Buffer.from(file.data, 'base64');
    bytes += buffer.length;
    if (!buffer.length || buffer.length > MAX_FILE_BYTES || bytes > MAX_TOTAL_BYTES) throw new Error('Limit: 5 MB per file, 8 MB total.');
    let text;
    if (extension === '.pdf') {
      const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const task = getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: true });
      try {
        const pdf = await task.promise;
        if (pdf.numPages > 100) throw new Error(`${name}: limit is 100 pages.`);
        const pages = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const content = await page.getTextContent();
          pages.push(content.items.map(item => (item.str ?? '') + (item.hasEOL ? '\n' : ' ')).join(''));
        }
        text = pages.join('\n\n');
      } finally { await task.destroy(); }
    } else if (extension === '.docx') {
      const { default: mammoth } = await import('mammoth');
      text = (await mammoth.extractRawText({ buffer })).value;
    } else {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    }
    text = text.replace(/\u0000/g, '').trim();
    if (!text) throw new Error(`${name}: no readable text. Scanned PDFs need OCR first.`);
    characters += text.length;
    if (characters > MAX_TEXT) throw new Error('Documents exceed 200,000 extracted characters. Upload shorter references.');
    const id = randomUUID();
    const chunks = [];
    for (let start = 0; start < text.length; start += 1100) {
      chunks.push({ id: `${id}:${chunks.length + 1}`, name, text: text.slice(start, start + 1400) });
    }
    documents.push({ id, name, characters: text.length, chunks });
  }
  return documents;
}

export function retrieveReferences(documents, query, limit = 10) {
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])];
  const chunks = documents.flatMap(document => document.chunks);
  // Small briefs fit in full. Larger collections use lexical passage retrieval.
  if (chunks.length <= limit) return chunks;
  return chunks.map((chunk, index) => ({ chunk, index, score: terms.reduce((score, term) => score + (chunk.text.toLowerCase().includes(term) ? 1 : 0), 0) }))
    .sort((a, b) => b.score - a.score || a.index - b.index).slice(0, limit).map(item => item.chunk);
}
