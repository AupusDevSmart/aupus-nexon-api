/**
 * Boletim Semanal da Operação — Aupus Energia
 * ===========================================
 *
 *   import { gerarPdf, gerarHtml } from './src/boletim.js';
 *
 *   const pdf = await gerarPdf(dados);              // Buffer
 *   await gerarPdf(dados, { saida: 'bol.pdf' });    // grava em disco
 *   const html = gerarHtml(dados);                  // string autocontida
 *
 * O PDF sai do Chrome headless (Puppeteer). Se preferir outro renderizador —
 * Playwright, Gotenberg, DocRaptor, um serviço interno — use gerarHtml e mande
 * a string: o HTML é autocontido (CSS embutido, logo em data URI, zero JS).
 */

import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { montarHtml, montarKpis, montarComparativo } from './template.js';

const AQUI = dirname(fileURLToPath(import.meta.url));

const CSS_PADRAO = readFileSync(resolve(AQUI, 'estilo.css'), 'utf8');
const LOGO_PADRAO = `data:image/png;base64,${readFileSync(resolve(AQUI, 'logo-clara.png')).toString('base64')}`;

export { montarKpis, montarComparativo };

/** HTML autocontido do boletim. */
export function gerarHtml(dados, { css = CSS_PADRAO, logo = LOGO_PADRAO } = {}) {
  return montarHtml(dados, { css, logo });
}

/**
 * PDF do boletim (A4 retrato, página única).
 * @returns {Promise<Buffer>} bytes do PDF — útil para responder direto num endpoint.
 */
export async function gerarPdf(dados, { saida = null, css, logo, puppeteerOptions = {} } = {}) {
  const { default: puppeteer } = await import('puppeteer');

  const navegador = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    ...puppeteerOptions,
  });

  try {
    const pagina = await navegador.newPage();
    await pagina.setContent(gerarHtml(dados, { css, logo }), { waitUntil: 'load' });

    const pdf = await pagina.pdf({
      format: 'A4',
      printBackground: true, // sem isto as faixas navy e os cards saem brancos
      preferCSSPageSize: true, // respeita o @page do estilo.css
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    });

    if (saida) await writeFile(saida, pdf);
    return pdf;
  } finally {
    await navegador.close();
  }
}
