import { extname } from 'node:path';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';
import { PDFParse } from 'pdf-parse';
import { repairMojibake } from '../processing/text.js';
const run = promisify(execFile);
export const extensions = ['.txt', '.md', '.csv', '.json', '.pdf', '.docx', '.xlsx'];
export type ExtractedDocument = { text: string; pages?: Array<{ page: number; text: string }> };
function hasMeaningfulPdfText(text: string) {
  return text.replace(/--\s*\d+\s+of\s+\d+\s*--/gi, '').replace(/\s+/g, ' ').trim().length >= 20;
}
async function extractPdfWithOcr(buffer: Buffer) {
  const directory = await mkdtemp(tmpdir() + '/lumina-ocr-');
  const input = directory + '/input.pdf';
  const prefix = directory + '/page';
  const pdftoppm = process.env.LUMINA_PDFTOPPM_PATH || (process.platform === 'win32' ? 'pdftoppm.exe' : 'pdftoppm');
  const tesseract = process.env.LUMINA_TESSERACT_PATH || (process.platform === 'win32' ? 'tesseract.exe' : 'tesseract');
  try {
    await writeFile(input, buffer);
    await run(pdftoppm, ['-r', '180', '-png', input, prefix], { windowsHide: true, maxBuffer: 1024 * 1024 });
    const files = (await readdir(directory)).filter(name => name.endsWith('.png')).sort();
    if (!files.length) throw new Error('O renderizador PDF não produziu páginas para OCR.');
    const pages: string[] = [];
    for (const file of files) {
      const result = await run(tesseract, [directory + '/' + file, 'stdout', '-l', 'por'], { windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
      pages.push(result.stdout);
    }
    return { text: pages.map((text, index) => `\n\n[[LUMINA_PAGE:${index + 1}]]\n${text}`).join('\n'), pages: pages.map((text, index) => ({ page: index + 1, text })) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'ferramenta indisponível';
    throw new Error('OCR indisponível. Instale/configure Poppler e Tesseract. ' + detail.slice(0, 180));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
export async function extract(name: string, buffer: Buffer): Promise<ExtractedDocument> {
  const ext = extname(name).toLowerCase();
  if (!extensions.includes(ext)) throw new Error('Formato não suportado. Use TXT, MD, CSV, JSON, PDF, DOCX ou XLSX.');
  if (ext === '.pdf') {
    if (!buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('Conteúdo PDF inválido.');
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
      const result = await parser.getText();
      if (hasMeaningfulPdfText(result.text)) {
        const pages = result.pages.map(page => ({ page: page.num, text: repairMojibake(page.text) }));
        return { text: pages.map(page => `\n\n[[LUMINA_PAGE:${page.page}]]\n${page.text}`).join('\n'), pages };
      }
    } finally { await parser.destroy(); }
    return extractPdfWithOcr(buffer);
  }
  if (ext === '.docx' || ext === '.xlsx') {
    if (buffer.readUInt32LE(0) !== 0x04034b50) throw new Error('Arquivo Office inválido.');
    // Reject containers declaring excessive expanded sizes before handing to parsers.
    let expanded = 0, entries = 0;
    for (let i = 0; i < buffer.length - 46; i++) {
      if (buffer.readUInt32LE(i) === 0x02014b50) {
        expanded += buffer.readUInt32LE(i + 24); entries++;
        if (expanded > 200 * 1024 * 1024 || entries > 10000) throw new Error('Arquivo Office excede o limite de descompressão (200 MB ou 10.000 entradas).');
      }
    }
    if (!entries) throw new Error('Índice do arquivo Office inválido.');
    if (ext === '.docx') return { text: repairMojibake((await mammoth.extractRawText({ buffer })).value) };
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(buffer as any);
    const rows: string[] = [];
    book.eachSheet(sheet => {
      rows.push('Planilha: ' + sheet.name);
      sheet.eachRow(row => { rows.push((row.values as ExcelJS.CellValue[]).slice(1).map(value => {
        if (value && typeof value === 'object') {
          if ('text' in value) return value.text;
          if ('richText' in value) return value.richText.map(v => v.text).join('');
          if ('result' in value) return String(value.result ?? '');
          return '';
        }
        return String(value ?? '');
      }).join(' | ')); });
    });
    return { text: rows.join('\n') };
  }
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch {
    text = new TextDecoder('windows-1252').decode(buffer);
  }
  if (ext === '.json') JSON.parse(text);
  return { text: repairMojibake(text) };
}
