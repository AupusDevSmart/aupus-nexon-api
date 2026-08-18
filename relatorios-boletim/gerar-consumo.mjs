#!/usr/bin/env node
/**
 * Gerador do Relatório de Gestão de Energia (CONSUMO) — MESMA VIA do boletim de geração
 * (child-process, puppeteer isolado, mesmas opções de PDF). Aqui o relatório é um
 * componente React → SSR (react-dom/server) para HTML → Puppeteer para PDF.
 *
 * O componente é pré-compilado por esbuild em ./consumo/bundle.mjs (JSX→JS, react externo),
 * pois o Node não roda JSX direto. Recompilar: npm run build:consumo (ver package.json).
 *
 *   node gerar-consumo.mjs [dados.json] [saida.pdf|saida.html]
 * Se a saída terminar em .html, escreve só o HTML (sem Puppeteer).
 */
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import RelatorioConsumo from './consumo/bundle.mjs';

const entrada = process.argv[2] ?? 'consumo/dados_exemplo_consumo.json';
const saida = process.argv[3] ?? 'relatorio-consumo.pdf';

const dados = JSON.parse(readFileSync(entrada, 'utf8'));
const css = readFileSync(new URL('./consumo/relatorio-consumo.css', import.meta.url), 'utf8');

const corpo = renderToStaticMarkup(React.createElement(RelatorioConsumo, { dados, logo: undefined }));
const html = `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="utf-8">
<title>Relatório de Gestão de Energia</title><style>${css}</style></head>
<body style="margin:0">${corpo}</body></html>`;

if (saida.endsWith('.html')) {
  await writeFile(saida, html);
} else {
  const { default: puppeteer } = await import('puppeteer');
  const navegador = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const pagina = await navegador.newPage();
    await pagina.setContent(html, { waitUntil: 'load' });
    await pagina.pdf({
      path: saida,
      format: 'A4',
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    });
  } finally {
    await navegador.close();
  }
}
console.log(`Gerado: ${saida}`);
