/**
 * Gráficos em SVG puro — sem biblioteca e sem JavaScript no documento.
 * Assim o mesmo HTML renderiza no Chrome headless, em serviços de PDF ou no e-mail.
 */

import { fmt, esc } from './formato.js';

// Paleta — espelha as variáveis do estilo.css. Ao mudar uma, mude a outra.
export const COR_ATUAL = '#16A34A'; // série do ano corrente
export const COR_ANTERIOR = '#35415C'; // série do ano anterior
export const COR_ESPERADO = '#9AA3B2'; // curva do modelo
export const COR_GRADE = '#E4E9F0';
export const COR_TEXTO = '#6B7280';
export const COR_CRITICO = '#D92D20';
export const COR_NAO_CRITICO = '#F59E0B';
export const COR_BARRA = '#1F2A44';

/** Arredonda o topo do eixo Y para um valor "redondo". */
function escalaAgradavel(maximo, divisoes = 4) {
  if (maximo <= 0) return { topo: 1, ticks: [0] };
  const passoBruto = maximo / divisoes;
  const magnitude = 10 ** Math.floor(Math.log10(passoBruto));
  let passo = magnitude;
  for (const mult of [1, 1.5, 2, 2.5, 3, 4, 5, 10]) {
    passo = magnitude * mult;
    if (passo * divisoes >= maximo) break;
  }
  const topo = passo * divisoes;
  return { topo, ticks: Array.from({ length: divisoes + 1 }, (_, i) => passo * i) };
}

/** Linhas: real do ano atual, real do ano anterior e curva esperada. */
export function graficoLinha(serie, { largura = 980, altura = 232 } = {}) {
  const esq = 46;
  const dir = 12;
  const topoM = 12;
  const baseM = 30;
  const x0 = esq;
  const x1 = largura - dir;
  const y0 = topoM;
  const y1 = altura - baseM;

  const temAnterior = serie.some((p) => p.anterior != null);
  const maximo = Math.max(0, ...serie.map((p) => Math.max(p.atual || 0, temAnterior ? (p.anterior || 0) : 0, p.esperado || 0)));
  const { topo, ticks } = escalaAgradavel(maximo);

  const n = serie.length;
  const passoX = (x1 - x0) / Math.max(n - 1, 1);
  const px = (i) => x0 + passoX * i;
  const py = (v) => y1 - (v / topo) * (y1 - y0);

  const s = [
    `<svg viewBox="0 0 ${largura} ${altura}" xmlns="http://www.w3.org/2000/svg" font-family="DejaVu Sans, Arial, sans-serif">`,
  ];

  // grade horizontal e rótulos do eixo Y
  for (const t of ticks) {
    const y = py(t);
    s.push(
      `<line x1="${x0}" y1="${y.toFixed(1)}" x2="${x1}" y2="${y.toFixed(1)}" stroke="${COR_GRADE}" stroke-width="1"/>`,
    );
    s.push(
      `<text x="${x0 - 8}" y="${(y + 3.5).toFixed(1)}" font-size="10" fill="${COR_TEXTO}" text-anchor="end">${fmt(t, 0)}</text>`,
    );
  }

  // rótulos do eixo X
  serie.forEach((p, i) => {
    s.push(
      `<text x="${px(i).toFixed(1)}" y="${altura - 13}" font-size="10" fill="${COR_TEXTO}" text-anchor="middle">${esc(p.rotulo)}</text>`,
    );
    s.push(
      `<text x="${px(i).toFixed(1)}" y="${altura - 3}" font-size="8.5" fill="#9AA3B2" text-anchor="middle">${esc(p.dia)}</text>`,
    );
  });

  const caminho = (chave) =>
    serie.map((p, i) => `${i === 0 ? 'M' : 'L'}${px(i).toFixed(1)},${py(p[chave]).toFixed(1)}`).join(' ');

  // área sob a série atual
  const area = `${caminho('atual')} L${px(n - 1).toFixed(1)},${y1.toFixed(1)} L${px(0).toFixed(1)},${y1.toFixed(1)} Z`;
  s.push(`<path d="${area}" fill="${COR_ATUAL}" fill-opacity="0.10"/>`);

  s.push(
    `<path d="${caminho('esperado')}" fill="none" stroke="${COR_ESPERADO}" stroke-width="2" stroke-dasharray="6 5" stroke-linejoin="round"/>`,
  );
  if (temAnterior) {
    s.push(
      `<path d="${caminho('anterior')}" fill="none" stroke="${COR_ANTERIOR}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>`,
    );
  }
  s.push(
    `<path d="${caminho('atual')}" fill="none" stroke="${COR_ATUAL}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>`,
  );

  // marcadores e valores da série atual
  serie.forEach((p, i) => {
    if (temAnterior) {
      s.push(
        `<circle cx="${px(i).toFixed(1)}" cy="${py(p.anterior).toFixed(1)}" r="3" fill="#FFFFFF" stroke="${COR_ANTERIOR}" stroke-width="2"/>`,
      );
    }
    s.push(
      `<circle cx="${px(i).toFixed(1)}" cy="${py(p.atual).toFixed(1)}" r="4" fill="#FFFFFF" stroke="${COR_ATUAL}" stroke-width="2.6"/>`,
    );
    s.push(
      `<text x="${px(i).toFixed(1)}" y="${(py(p.atual) - 10).toFixed(1)}" font-size="10" font-weight="700" fill="${COR_ATUAL}" text-anchor="middle">${fmt(p.atual, 1)}</text>`,
    );
  });

  s.push('</svg>');
  return s.join('\n');
}

/** Rosca de severidade dos alarmes, com o total no centro. */
export function graficoRosca(criticos, naoCriticos, { tamanho = 150 } = {}) {
  const total = criticos + naoCriticos;
  const cx = tamanho / 2;
  const cy = tamanho / 2;
  const espessura = 17;
  const raio = tamanho / 2 - 8;
  const r = raio - espessura / 2;
  const perimetro = 2 * Math.PI * r;

  const s = [
    `<svg viewBox="0 0 ${tamanho} ${tamanho}" xmlns="http://www.w3.org/2000/svg" font-family="DejaVu Sans, Arial, sans-serif">`,
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#EEF1F6" stroke-width="${espessura}"/>`,
  ];

  let inicio = 0;
  for (const [valor, cor] of [
    [criticos, COR_CRITICO],
    [naoCriticos, COR_NAO_CRITICO],
  ]) {
    if (!total || !valor) continue;
    const comprimento = (perimetro * valor) / total;
    s.push(
      `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${cor}" stroke-width="${espessura}" ` +
        `stroke-linecap="butt" stroke-dasharray="${comprimento.toFixed(2)} ${(perimetro - comprimento).toFixed(2)}" ` +
        `stroke-dashoffset="${(-inicio).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`,
    );
    inicio += comprimento;
  }

  s.push(
    `<text x="${cx}" y="${cy + 2}" font-size="26" font-weight="700" fill="#10203C" text-anchor="middle">${total}</text>`,
  );
  s.push(
    `<text x="${cx}" y="${cy + 17}" font-size="10" fill="${COR_TEXTO}" text-anchor="middle">alarmes</text>`,
  );
  s.push('</svg>');
  return s.join('\n');
}

/** Barras horizontais dos tipos de alarme. */
export function graficoBarras(tipos, { largura = 310, alturaLinha = 23 } = {}) {
  const altura = alturaLinha * tipos.length + 6;
  const rotuloW = 104;
  const x0 = rotuloW + 7;
  const x1 = largura - 20;
  const maximo = Math.max(...tipos.map((t) => t.qtd)) || 1;

  const s = [
    `<svg viewBox="0 0 ${largura} ${altura}" xmlns="http://www.w3.org/2000/svg" font-family="DejaVu Sans, Arial, sans-serif">`,
  ];

  tipos.forEach((t, i) => {
    const y = i * alturaLinha + 4;
    const h = alturaLinha - 12;
    const larguraBarra = ((x1 - x0) * t.qtd) / maximo;
    s.push(
      `<text x="${rotuloW}" y="${y + h - 1}" font-size="11.5" fill="#1F2A44" text-anchor="end">${esc(t.tipo)}</text>`,
    );
    s.push(`<rect x="${x0}" y="${y}" width="${x1 - x0}" height="${h}" rx="3" fill="#F2F5F9"/>`);
    s.push(
      `<rect x="${x0}" y="${y}" width="${larguraBarra.toFixed(1)}" height="${h}" rx="3" fill="${COR_BARRA}"/>`,
    );
    s.push(
      `<text x="${(x0 + larguraBarra + 6).toFixed(1)}" y="${y + h - 2}" font-size="11.5" font-weight="700" fill="#10203C">${t.qtd}</text>`,
    );
  });

  s.push('</svg>');
  return s.join('\n');
}
