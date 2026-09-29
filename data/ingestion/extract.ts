import { extname, join } from 'node:path';
import {
  mkdtemp,
  readdir,
  rm,
  writeFile,
  unlink
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import mammoth from 'mammoth';
import ExcelJS from 'exceljs';
import { PDFParse } from 'pdf-parse';

import { repairMojibake } from '../processing/text.js';

const run = promisify(execFile);

/* ============================================================
 * CONFIGURAÇÃO
 * ============================================================
 */

export const extensions = [
  '.txt',
  '.md',
  '.csv',
  '.json',
  '.pdf',
  '.docx',
  '.xlsx'
];

const OCR_DPI = Number(
  process.env.LUMINA_OCR_DPI || 180
);

const OCR_MAX_RANGE_SIZE = Math.max(
  1,
  Number(process.env.LUMINA_OCR_BATCH_SIZE || 10)
);

const OCR_MAX_BUFFER =
  10 * 1024 * 1024;

/* ============================================================
 * TIPOS
 * ============================================================
 */

export type ExtractionMethod =
  | 'native'
  | 'ocr'
  | 'failed';

export type ExtractedPage = {
  page: number;
  text: string;

  extractionMethod: ExtractionMethod;

  /**
   * Qualidade final da página escolhida.
   * Intervalo esperado: 0..1
   */
  quality: number;

  /**
   * Qualidade encontrada originalmente
   * pelo extrator nativo.
   */
  nativeQuality?: number;

  /**
   * Qualidade encontrada pelo OCR.
   */
  ocrQuality?: number;

  /**
   * Indica se o OCR foi solicitado.
   */
  ocrRequested?: boolean;

  /**
   * Erro específico da página.
   * Não aborta necessariamente o documento.
   */
  error?: string;
};

export type ExtractionTelemetry = {
  totalPages: number;

  nativePagesCount: number;

  ocrRequestedPagesCount: number;

  ocrSuccessPagesCount: number;

  ocrFailedPagesCount: number;

  lowQualityPagesCount: number;

  totalChars: number;

  extractionTimeMs: number;

  nativeExtractionTimeMs: number;

  ocrTimeMs: number;
};

export type ExtractedDocument = {
  text: string;

  pages?: ExtractedPage[];

  telemetry?: ExtractionTelemetry;
};

type PageQuality = {
  isValid: boolean;
  score: number;
};

type OcrResult = {
  text: string;
  quality: number;
  success: boolean;
  error?: string;
};

type PageRange = {
  start: number;
  end: number;
};

/* ============================================================
 * QUALIDADE DE TEXTO
 * ============================================================
 */

/**
 * Avalia se um texto extraído parece minimamente utilizável.
 *
 * IMPORTANTE:
 * Isso NÃO tenta determinar se o conteúdo está juridicamente correto.
 *
 * Apenas detecta sinais típicos de:
 * - página vazia;
 * - extração quebrada;
 * - caracteres ilegíveis;
 * - conteúdo sem quantidade razoável de letras;
 * - lixo produzido por parser/OCR.
 */
function evaluatePageQuality(
  text: string
): PageQuality {

  const clean = repairMojibake(text || '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!clean) {
    return {
      isValid: false,
      score: 0
    };
  }

  /*
   * Não usamos um limite grande como 100 caracteres.
   *
   * Uma página jurídica perfeitamente válida pode conter apenas:
   *
   * "Art. 15. Revogado."
   */
  if (clean.length < 20) {
    return {
      isValid: false,
      score: 0.1
    };
  }

  const letters =
    (clean.match(/\p{L}/gu) ?? []).length;

  const printable =
    (
      clean.match(
        /[\p{L}\p{N}\p{P}\p{Zs}]/gu
      ) ?? []
    ).length;

  const words =
    (
      clean.match(
        /\b[\p{L}]{2,}\b/gu
      ) ?? []
    ).length;

  const letterRatio =
    letters / clean.length;

  const printableRatio =
    printable / clean.length;

  /*
   * Quantidade mínima de palavras recebe
   * peso pequeno.
   *
   * Serve apenas para ajudar a identificar
   * lixo de extração.
   */
  const wordScore =
    Math.min(words / 15, 1);

  /*
   * Penalização simples para sequências
   * anormalmente repetitivas.
   *
   * Ex:
   *
   * |||||||||||||||
   * IIIIIIIIIIIIIII
   * ...............
   */
  const suspiciousRepetition =
    /(.)\1{9,}/u.test(clean);

  let score =
    (letterRatio * 0.50) +
    (printableRatio * 0.35) +
    (wordScore * 0.15);

  if (suspiciousRepetition) {
    score *= 0.65;
  }

  score = Math.max(
    0,
    Math.min(1, score)
  );

  score = Number(
    score.toFixed(3)
  );

  const isValid =
    letterRatio >= 0.30 &&
    printableRatio >= 0.78 &&
    score >= 0.50;

  return {
    isValid,
    score
  };
}

/* ============================================================
 * RANGES DE OCR
 * ============================================================
 */

/**
 * Agrupa páginas consecutivas, mas nunca permite
 * que um intervalo ultrapasse maxRangeSize.
 *
 * Exemplo:
 *
 * páginas:
 * 31 32 33 34 35 36
 *
 * maxRangeSize = 3
 *
 * resultado:
 *
 * 31-33
 * 34-36
 */
function groupContinuousRanges(
  pageNumbers: number[],
  maxRangeSize = OCR_MAX_RANGE_SIZE
): PageRange[] {

  if (!pageNumbers.length) {
    return [];
  }

  /*
   * Remove duplicações e garante ordenação
   * numérica.
   */
  const pages = [
    ...new Set(
      pageNumbers.filter(
        page =>
          Number.isInteger(page) &&
          page > 0
      )
    )
  ].sort(
    (a, b) => a - b
  );

  if (!pages.length) {
    return [];
  }

  const ranges: PageRange[] = [];

  let start = pages[0];
  let end = pages[0];

  for (
    let i = 1;
    i < pages.length;
    i++
  ) {

    const current = pages[i];

    const consecutive =
      current === end + 1;

    const rangeSize =
      current - start + 1;

    const withinLimit =
      rangeSize <= maxRangeSize;

    if (
      consecutive &&
      withinLimit
    ) {
      end = current;
      continue;
    }

    ranges.push({
      start,
      end
    });

    start = current;
    end = current;
  }

  ranges.push({
    start,
    end
  });

  return ranges;
}

/* ============================================================
 * CONFIGURAÇÃO OCR
 * ============================================================
 */

function getPdfToPpmPath(): string {
  return (
    process.env.LUMINA_PDFTOPPM_PATH ||
    (
      process.platform === 'win32'
        ? 'pdftoppm.exe'
        : 'pdftoppm'
    )
  );
}

function getTesseractPath(): string {
  return (
    process.env.LUMINA_TESSERACT_PATH ||
    (
      process.platform === 'win32'
        ? 'tesseract.exe'
        : 'tesseract'
    )
  );
}

function getOcrLanguage(): string {
  return (
    process.env.LUMINA_OCR_LANG ||
    'por'
  );
}

/* ============================================================
 * IDENTIFICAÇÃO DOS PNGs
 * ============================================================
 */

/**
 * Extrai o número presente no final do nome produzido
 * pelo pdftoppm.
 *
 * Exemplos:
 *
 * page-1.png
 * page-01.png
 * page-001.png
 *
 * -> 1
 */
function extractRenderedPageNumber(
  filename: string
): number | undefined {

  const match =
    filename.match(
      /-(\d+)\.png$/i
    );

  if (!match) {
    return undefined;
  }

  const value =
    Number(match[1]);

  return Number.isInteger(value)
    ? value
    : undefined;
}

/* ============================================================
 * TESSERACT
 * ============================================================
 */

async function runTesseract(
  imagePath: string
): Promise<OcrResult> {

  const tesseract =
    getTesseractPath();

  const language =
    getOcrLanguage();

  const env = {
    ...process.env
  };

  /*
   * Normalmente process.env já contém
   * TESSDATA_PREFIX.
   *
   * Mantemos explicitamente para tornar
   * a intenção clara.
   */
  if (
    process.env.TESSDATA_PREFIX
  ) {
    env.TESSDATA_PREFIX =
      process.env.TESSDATA_PREFIX;
  }

  try {

    const result =
      await run(
        tesseract,
        [
          imagePath,
          'stdout',
          '-l',
          language
        ],
        {
          env,
          windowsHide: true,
          maxBuffer:
            OCR_MAX_BUFFER
        }
      );

    const text =
      repairMojibake(
        result.stdout || ''
      );

    const quality =
      evaluatePageQuality(text);

    return {
      text,
      quality:
        quality.score,
      success:
        quality.isValid
    };

  } catch (error) {

    const detail =
      error instanceof Error
        ? error.message
        : 'Falha desconhecida no Tesseract.';

    return {
      text: '',
      quality: 0,
      success: false,
      error:
        detail.slice(0, 300)
    };
  }
}

/* ============================================================
 * OCR DE UM RANGE
 * ============================================================
 */

/**
 * Renderiza somente um pequeno intervalo do PDF.
 *
 * O PDF temporário já existe e NÃO é escrito
 * novamente a cada range.
 */
async function processOcrRange(
  pdfPath: string,
  workingDirectory: string,
  startPage: number,
  endPage: number
): Promise<Map<number, OcrResult>> {

  const results =
    new Map<number, OcrResult>();

  const pdftoppm =
    getPdfToPpmPath();

  /*
   * Prefixo único para evitar colisões entre ranges.
   */
  const prefix =
    join(
      workingDirectory,
      `ocr-${startPage}-${endPage}`
    );

  try {

    await run(
      pdftoppm,
      [
        '-r',
        String(OCR_DPI),

        '-png',

        '-f',
        String(startPage),

        '-l',
        String(endPage),

        pdfPath,
        prefix
      ],
      {
        windowsHide: true,

        /*
         * pdftoppm normalmente escreve pouco
         * em stdout/stderr, mas mantemos proteção.
         */
        maxBuffer:
          OCR_MAX_BUFFER
      }
    );

  } catch (error) {

    const detail =
      error instanceof Error
        ? error.message
        : 'Falha desconhecida no pdftoppm.';

    /*
     * Falha do renderizador NÃO derruba
     * o documento inteiro.
     */
    for (
      let page = startPage;
      page <= endPage;
      page++
    ) {
      results.set(
        page,
        {
          text: '',
          quality: 0,
          success: false,
          error:
            `Falha ao renderizar página para OCR: ${detail.slice(0, 250)}`
        }
      );
    }

    return results;
  }

  const filenames =
    (
      await readdir(
        workingDirectory
      )
    ).filter(
      name =>
        name.startsWith(
          `ocr-${startPage}-${endPage}-`
        ) &&
        name.toLowerCase().endsWith(
          '.png'
        )
    );

  /*
   * NÃO confiamos em .sort() lexicográfico.
   *
   * Mapeamos explicitamente o número produzido
   * pelo pdftoppm.
   */
  const rendered =
    filenames
      .map(filename => ({
        filename,
        renderedPage:
          extractRenderedPageNumber(
            filename
          )
      }))
      .filter(
        (
          item
        ): item is {
          filename: string;
          renderedPage: number;
        } =>
          item.renderedPage !==
          undefined
      )
      .sort(
        (a, b) =>
          a.renderedPage -
          b.renderedPage
      );

  /*
   * Com -f/-l, algumas versões do pdftoppm
   * preservam o número real da página no nome.
   *
   * Outras situações podem produzir numeração
   * relativa.
   *
   * Portanto verificamos primeiro se os números
   * estão dentro do range real.
   */
  const numbersLookAbsolute =
    rendered.length > 0 &&
    rendered.every(
      item =>
        item.renderedPage >=
          startPage &&
        item.renderedPage <=
          endPage
    );

  for (
    let index = 0;
    index < rendered.length;
    index++
  ) {

    const item =
      rendered[index];

    const pageNumber =
      numbersLookAbsolute
        ? item.renderedPage
        : startPage + index;

    if (
      pageNumber < startPage ||
      pageNumber > endPage
    ) {
      continue;
    }

    const imagePath =
      join(
        workingDirectory,
        item.filename
      );

    try {

      const ocr =
        await runTesseract(
          imagePath
        );

      results.set(
        pageNumber,
        ocr
      );

    } finally {

      /*
       * PNG eliminado imediatamente.
       */
      await unlink(
        imagePath
      ).catch(
        () => undefined
      );
    }
  }

  /*
   * Detecta páginas que deveriam ter sido
   * renderizadas mas não apareceram.
   */
  for (
    let page = startPage;
    page <= endPage;
    page++
  ) {

    if (
      !results.has(page)
    ) {
      results.set(
        page,
        {
          text: '',
          quality: 0,
          success: false,
          error:
            'O pdftoppm não produziu imagem para esta página.'
        }
      );
    }
  }

  return results;
}

/* ============================================================
 * EXTRAÇÃO PDF HÍBRIDA
 * ============================================================
 */

async function extractPdf(
  buffer: Buffer
): Promise<ExtractedDocument> {

  const extractionStartedAt =
    Date.now();

  const nativeStartedAt =
    Date.now();

  const parser =
    new PDFParse({
      data:
        new Uint8Array(
          buffer
        )
    });

  let nativeExtractionTimeMs =
    0;

  let ocrTimeMs =
    0;

  let workingDirectory:
    string | undefined;

  try {

    /* --------------------------------------------------------
     * 1. EXTRAÇÃO NATIVA
     * --------------------------------------------------------
     */

    const result =
      await parser.getText();

    nativeExtractionTimeMs =
      Date.now() -
      nativeStartedAt;

    const pages:
      ExtractedPage[] = [];

    const pagesNeedingOcr:
      number[] = [];

    for (
      const page of result.pages
    ) {

      const text =
        repairMojibake(
          page.text || ''
        );

      const quality =
        evaluatePageQuality(
          text
        );

      if (
        quality.isValid
      ) {

        pages.push({
          page:
            page.num,

          text,

          extractionMethod:
            'native',

          quality:
            quality.score,

          nativeQuality:
            quality.score,

          ocrRequested:
            false
        });

      } else {

        pagesNeedingOcr.push(
          page.num
        );

        /*
         * Mantemos o texto nativo original.
         *
         * Isso é importante.
         *
         * Caso o OCR falhe, ainda podemos
         * comparar/recuperar o texto original
         * em vez de descartá-lo imediatamente.
         */
        pages.push({
          page:
            page.num,

          text,

          extractionMethod:
            'native',

          quality:
            quality.score,

          nativeQuality:
            quality.score,

          ocrRequested:
            true
        });
      }
    }

    /* --------------------------------------------------------
     * 2. OCR SELETIVO
     * --------------------------------------------------------
     */

    if (
      pagesNeedingOcr.length
    ) {

      const ocrStartedAt =
        Date.now();

      /*
       * Diretório criado UMA única vez
       * por documento.
       */
      workingDirectory =
        await mkdtemp(
          join(
            tmpdir(),
            'lumina-ocr-'
          )
        );

      /*
       * PDF escrito UMA única vez.
       */
      const pdfPath =
        join(
          workingDirectory,
          'input.pdf'
        );

      await writeFile(
        pdfPath,
        buffer
      );

      /*
       * Ranges contínuos, mas limitados.
       *
       * Ex:
       *
       * 31-40
       * 41-50
       * 51-54
       */
      const ranges =
        groupContinuousRanges(
          pagesNeedingOcr
        );

      const ocrResults =
        new Map<
          number,
          OcrResult
        >();

      for (
        const range of ranges
      ) {

        const rangeResults =
          await processOcrRange(
            pdfPath,
            workingDirectory,
            range.start,
            range.end
          );

        for (
          const [
            pageNumber,
            result
          ] of rangeResults
        ) {

          ocrResults.set(
            pageNumber,
            result
          );
        }
      }

      /* ------------------------------------------------------
       * 3. ESCOLHA ENTRE NATIVO E OCR
       * ------------------------------------------------------
       */

      for (
        const page of pages
      ) {

        if (
          !page.ocrRequested
        ) {
          continue;
        }

        const ocr =
          ocrResults.get(
            page.page
          );

        if (!ocr) {

          page.error =
            'OCR solicitado, mas nenhum resultado foi produzido.';

          continue;
        }

        page.ocrQuality =
          ocr.quality;

        /*
         * OCR válido:
         *
         * escolhemos OCR quando:
         *
         * 1. passou na validação;
         * OU
         * 2. é claramente melhor que o nativo.
         */
        const nativeQuality =
          page.nativeQuality ??
          0;

        const shouldUseOcr =
          ocr.success ||
          (
            ocr.text.trim()
              .length > 0 &&
            ocr.quality >
              nativeQuality +
                0.10
          );

        if (
          shouldUseOcr
        ) {

          page.text =
            ocr.text;

          page.quality =
            ocr.quality;

          page.extractionMethod =
            'ocr';

          continue;
        }

        /*
         * Se OCR falhou mas ainda temos algum
         * texto nativo, preservamos o nativo.
         */
        if (
          page.text.trim()
            .length > 0
        ) {

          page.extractionMethod =
            'native';

          page.quality =
            nativeQuality;

          page.error =
            ocr.error ||
            'OCR não apresentou qualidade superior ao texto nativo.';

          continue;
        }

        /*
         * Nenhuma extração utilizável.
         */
        page.extractionMethod =
          'failed';

        page.quality = 0;

        page.error =
          ocr.error ||
          'Não foi possível extrair texto utilizável desta página.';
      }

      ocrTimeMs =
        Date.now() -
        ocrStartedAt;
    }

    /* --------------------------------------------------------
     * 4. ORDENAÇÃO DEFENSIVA
     * --------------------------------------------------------
     */

    pages.sort(
      (a, b) =>
        a.page - b.page
    );

    /* --------------------------------------------------------
     * 5. TELEMETRIA
     * --------------------------------------------------------
     */

    const nativePagesCount =
      pages.filter(
        page =>
          page.extractionMethod ===
          'native'
      ).length;

    const ocrSuccessPagesCount =
      pages.filter(
        page =>
          page.extractionMethod ===
          'ocr'
      ).length;

    const ocrFailedPagesCount =
      pages.filter(
        page =>
          page.ocrRequested &&
          page.extractionMethod !==
            'ocr'
      ).length;

    const lowQualityPagesCount =
      pages.filter(
        page =>
          page.quality < 0.50
      ).length;

    const totalChars =
      pages.reduce(
        (
          total,
          page
        ) =>
          total +
          page.text.length,
        0
      );

    /* --------------------------------------------------------
     * 6. DOCUMENTO FINAL
     * --------------------------------------------------------
     *
     * IMPORTANTE:
     *
     * Mantemos exatamente:
     *
     * [[LUMINA_PAGE:123]]
     *
     * porque pipeline.ts atualmente depende
     * dessa sintaxe.
     *
     * NÃO colocamos METHOD/QUAL dentro do
     * marcador textual.
     * --------------------------------------------------------
     */

    const text =
      pages
        .map(
          page =>
            `\n\n[[LUMINA_PAGE:${page.page}]]\n${page.text}`
        )
        .join('\n');

    return {

      text,

      pages,

      telemetry: {

        totalPages:
          pages.length,

        nativePagesCount,

        ocrRequestedPagesCount:
          pagesNeedingOcr.length,

        ocrSuccessPagesCount,

        ocrFailedPagesCount,

        lowQualityPagesCount,

        totalChars,

        extractionTimeMs:
          Date.now() -
          extractionStartedAt,

        nativeExtractionTimeMs,

        ocrTimeMs
      }
    };

  } finally {

    /*
     * Libera recursos do PDFParse.
     */
    await parser.destroy();

    /*
     * Remove:
     *
     * - input.pdf
     * - PNGs residuais
     * - diretório temporário
     *
     * mesmo em caso de exceção.
     */
    if (
      workingDirectory
    ) {

      await rm(
        workingDirectory,
        {
          recursive: true,
          force: true
        }
      ).catch(
        () => undefined
      );
    }
  }
}

/* ============================================================
 * OFFICE
 * ============================================================
 */

function validateOfficeContainer(
  buffer: Buffer
): void {

  if (
    buffer.length < 4 ||
    buffer.readUInt32LE(0) !==
      0x04034b50
  ) {

    throw new Error(
      'Arquivo Office inválido.'
    );
  }

  let expanded = 0;
  let entries = 0;

  for (
    let i = 0;
    i < buffer.length - 46;
    i++
  ) {

    if (
      buffer.readUInt32LE(i) ===
      0x02014b50
    ) {

      expanded +=
        buffer.readUInt32LE(
          i + 24
        );

      entries++;

      /*
       * Proteção contra ZIP bomb.
       */
      if (
        expanded >
          200 *
            1024 *
            1024 ||
        entries > 10000
      ) {

        throw new Error(
          'Arquivo Office excede o limite de descompressão (200 MB ou 10.000 entradas).'
        );
      }
    }
  }

  if (!entries) {

    throw new Error(
      'Índice do arquivo Office inválido.'
    );
  }
}

/* ============================================================
 * DOCX
 * ============================================================
 */

async function extractDocx(
  buffer: Buffer
): Promise<ExtractedDocument> {

  validateOfficeContainer(
    buffer
  );

  const result =
    await mammoth.extractRawText({
      buffer
    });

  return {
    text:
      repairMojibake(
        result.value
      )
  };
}

/* ============================================================
 * XLSX
 * ============================================================
 */

async function extractXlsx(
  buffer: Buffer
): Promise<ExtractedDocument> {

  validateOfficeContainer(
    buffer
  );

  const book =
    new ExcelJS.Workbook();

  await book.xlsx.load(
    buffer as any
  );

  const rows:
    string[] = [];

  book.eachSheet(
    sheet => {

      rows.push(
        'Planilha: ' +
          sheet.name
      );

      sheet.eachRow(
        row => {

          const values =
            (
              row.values as
                ExcelJS.CellValue[]
            )
              .slice(1)
              .map(
                value => {

                  if (
                    value &&
                    typeof value ===
                      'object'
                  ) {

                    if (
                      'text' in value
                    ) {
                      return (
                        value.text ??
                        ''
                      );
                    }

                    if (
                      'richText' in
                      value
                    ) {

                      return value
                        .richText
                        .map(
                          item =>
                            item.text
                        )
                        .join('');
                    }

                    if (
                      'result' in
                      value
                    ) {

                      return String(
                        value.result ??
                          ''
                      );
                    }

                    return '';
                  }

                  return String(
                    value ?? ''
                  );
                }
              );

          rows.push(
            values.join(
              ' | '
            )
          );
        }
      );
    }
  );

  return {
    text:
      repairMojibake(
        rows.join('\n')
      )
  };
}

/* ============================================================
 * TEXTO
 * ============================================================
 */

function extractPlainText(
  buffer: Buffer
): string {

  try {

    return new TextDecoder(
      'utf-8',
      {
        fatal: true
      }
    ).decode(
      buffer
    );

  } catch {

    return new TextDecoder(
      'windows-1252'
    ).decode(
      buffer
    );
  }
}

/* ============================================================
 * FUNÇÃO PÚBLICA
 * ============================================================
 */

export async function extract(
  name: string,
  buffer: Buffer
): Promise<ExtractedDocument> {

  const ext =
    extname(name)
      .toLowerCase();

  if (
    !extensions.includes(
      ext
    )
  ) {

    throw new Error(
      'Formato não suportado. Use TXT, MD, CSV, JSON, PDF, DOCX ou XLSX.'
    );
  }

  /* ----------------------------------------------------------
   * PDF
   * ----------------------------------------------------------
   */

  if (
    ext === '.pdf'
  ) {

    if (
      buffer.length < 5 ||
      !buffer
        .subarray(0, 5)
        .equals(
          Buffer.from(
            '%PDF-'
          )
        )
    ) {

      throw new Error(
        'Conteúdo PDF inválido.'
      );
    }

    return extractPdf(
      buffer
    );
  }

  /* ----------------------------------------------------------
   * DOCX
   * ----------------------------------------------------------
   */

  if (
    ext === '.docx'
  ) {

    return extractDocx(
      buffer
    );
  }

  /* ----------------------------------------------------------
   * XLSX
   * ----------------------------------------------------------
   */

  if (
    ext === '.xlsx'
  ) {

    return extractXlsx(
      buffer
    );
  }

  /* ----------------------------------------------------------
   * TXT / MD / CSV / JSON
   * ----------------------------------------------------------
   */

  let text =
    extractPlainText(
      buffer
    );

  text =
    repairMojibake(
      text
    );

  if (
    ext === '.json'
  ) {

    /*
     * Validação sintática.
     *
     * Mantemos o texto original após validar.
     */
    JSON.parse(
      text
    );
  }

  return {
    text
  };
}
