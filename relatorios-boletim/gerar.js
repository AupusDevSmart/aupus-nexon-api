#!/usr/bin/env node
/**
 * CLI: node gerar.js [dados.json] [saida.pdf|saida.html]
 *
 * Se a saída terminar em .html, escreve só o HTML — sem depender do Puppeteer.
 * Útil para inspecionar o layout no navegador ou para renderizar em outro serviço.
 */

import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { gerarHtml, gerarPdf } from './src/boletim.js';

const entrada = process.argv[2] ?? 'dados_exemplo.json';
const saida = process.argv[3] ?? 'boletim-semanal.pdf';

const dados = JSON.parse(readFileSync(entrada, 'utf8'));

if (saida.endsWith('.html')) {
  await writeFile(saida, gerarHtml(dados));
} else {
  await gerarPdf(dados, { saida });
}

console.log(`Gerado: ${saida}`);
