/**
 * Gráficos do Relatório de Gestão de Energia — SVG desenhado em React.
 * Sem biblioteca externa e sem JS no documento: o mesmo markup serve para a tela e para o PDF.
 */

import React from 'react';
import { num } from './formato.js';

// Paleta — espelha as variáveis CSS no topo de relatorio-consumo.css
export const GRADE = '#E4E9F0';
export const TEXTO = '#6B7280';
export const NAVY = '#10203C';
export const CONTRATADA = '#2563EB';
export const ALERTA = '#D92D20';
export const LINHA = '#16A34A';

/** Topo do eixo arredondado para um valor "redondo". */
function escala(maximo, divisoes = 4) {
  if (maximo <= 0) return { topo: 1, ticks: [0] };
  const bruto = maximo / divisoes;
  const magnitude = 10 ** Math.floor(Math.log10(bruto));
  let passo = magnitude;
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 10]) {
    passo = magnitude * m;
    if (passo * divisoes >= maximo) break;
  }
  return { topo: passo * divisoes, ticks: Array.from({ length: divisoes + 1 }, (_, i) => passo * i) };
}

/** Coluna empilhada — consumo por posto tarifário. */
export function BarraEmpilhada({ segmentos, rodape = 'Semana atual', largura = 300, altura = 146 }) {
  const esq = 52;
  const y0 = 12;
  const y1 = altura - 30;
  const total = segmentos.reduce((s, p) => s + p.valor, 0);
  const { topo, ticks } = escala(total);

  const larguraCol = 96;
  const cx = esq + (largura - esq - 14 - larguraCol) / 2 + larguraCol / 2;
  const py = (v) => y1 - (v / topo) * (y1 - y0);

  let acumulado = 0;
  const fatias = segmentos.map((p) => {
    const yTopo = py(acumulado + p.valor);
    const alturaSeg = py(acumulado) - yTopo;
    acumulado += p.valor;
    return { ...p, yTopo, alturaSeg };
  });

  return (
    <svg viewBox={`0 0 ${largura} ${altura}`} className="svg-fluido">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={esq} y1={py(t)} x2={largura - 8} y2={py(t)} stroke={GRADE} strokeWidth="1" />
          <text x={esq - 7} y={py(t) + 3.5} fontSize="10" fill={TEXTO} textAnchor="end">
            {num(t)}
          </text>
        </g>
      ))}

      {fatias.map((f) => (
        <g key={f.rotulo}>
          <rect x={cx - larguraCol / 2} y={f.yTopo} width={larguraCol} height={f.alturaSeg} fill={f.cor} />
          {f.alturaSeg > 10 && (
            <text
              x={cx}
              y={f.yTopo + f.alturaSeg / 2 + 4}
              fontSize="11.5"
              fontWeight="700"
              fill="#FFFFFF"
              textAnchor="middle"
            >
              {num(f.valor)}
            </text>
          )}
        </g>
      ))}

      <line x1={esq} y1={y1} x2={largura - 8} y2={y1} stroke="#C7D0DC" strokeWidth="1.4" />
      <text x={cx} y={altura - 12} fontSize="10.5" fill={TEXTO} textAnchor="middle">
        {rodape}
      </text>
    </svg>
  );
}

/** Colunas verticais — custo previsto por posto tarifário. */
export function Colunas({ itens, largura = 320, altura = 140 }) {
  const esq = 56;
  const y0 = 20;
  const y1 = altura - 30;
  const { topo, ticks } = escala(Math.max(...itens.map((i) => i.valor)));
  const py = (v) => y1 - (v / topo) * (y1 - y0);

  const passo = (largura - esq - 12) / itens.length;
  const larguraCol = Math.min(passo * 0.52, 56);

  return (
    <svg viewBox={`0 0 ${largura} ${altura}`} className="svg-fluido">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={esq} y1={py(t)} x2={largura - 8} y2={py(t)} stroke={GRADE} strokeWidth="1" />
          <text x={esq - 7} y={py(t) + 3.5} fontSize="10" fill={TEXTO} textAnchor="end">
            {num(t)}
          </text>
        </g>
      ))}

      {itens.map((item, i) => {
        const cx = esq + passo * (i + 0.5);
        const y = py(item.valor);
        return (
          <g key={item.rotulo}>
            <rect x={cx - larguraCol / 2} y={y} width={larguraCol} height={y1 - y} rx="2" fill={item.cor} />
            <text x={cx} y={y - 7} fontSize="12" fontWeight="700" fill={NAVY} textAnchor="middle">
              {num(item.valor)}
            </text>
            <text x={cx} y={altura - 12} fontSize="10" fill={TEXTO} textAnchor="middle">
              {item.rotulo}
            </text>
          </g>
        );
      })}

      <line x1={esq} y1={y1} x2={largura - 8} y2={y1} stroke="#C7D0DC" strokeWidth="1.4" />
    </svg>
  );
}

/**
 * Demanda máxima diária × contratada.
 * Pontos acima da contratada saem em vermelho — a contagem de ultrapassagens vem daí.
 */
export function LinhaDemanda({ pontos, contratada, largura = 720, altura = 124 }) {
  const esq = 46;
  const dir = 44;
  const y0 = 16;
  const y1 = altura - 26;
  const x1 = largura - dir;

  const { topo, ticks } = escala(Math.max(contratada, ...pontos.map((p) => p.valor)));
  const passoX = (x1 - esq) / Math.max(pontos.length - 1, 1);
  const px = (i) => esq + passoX * i;
  const py = (v) => y1 - (v / topo) * (y1 - y0);

  const caminho = pontos.map((p, i) => `${i === 0 ? 'M' : 'L'}${px(i).toFixed(1)},${py(p.valor).toFixed(1)}`).join(' ');

  return (
    <svg viewBox={`0 0 ${largura} ${altura}`} className="svg-fluido">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={esq} y1={py(t)} x2={x1} y2={py(t)} stroke={GRADE} strokeWidth="1" />
          <text x={esq - 7} y={py(t) + 3.5} fontSize="9.5" fill={TEXTO} textAnchor="end">
            {num(t)}
          </text>
        </g>
      ))}

      <line x1={esq} y1={py(contratada)} x2={x1} y2={py(contratada)} stroke={CONTRATADA} strokeWidth="2" strokeDasharray="7 5" />
      <text x={x1 + 6} y={py(contratada) + 3} fontSize="11" fontWeight="700" fill={CONTRATADA}>
        {num(contratada)}
      </text>

      <path d={caminho} fill="none" stroke={LINHA} strokeWidth="2.6" strokeLinejoin="round" strokeLinecap="round" />

      {pontos.map((p, i) => {
        const cor = p.ultrapassou ? ALERTA : LINHA;
        return (
          <g key={p.rotulo}>
            <circle
              cx={px(i)}
              cy={py(p.valor)}
              r={p.ultrapassou ? 4.6 : 3.6}
              fill={p.ultrapassou ? cor : '#FFFFFF'}
              stroke={cor}
              strokeWidth="2.2"
            />
            <text
              x={px(i)}
              y={py(p.valor) - 10}
              fontSize="10"
              fontWeight="700"
              fill={p.ultrapassou ? cor : NAVY}
              textAnchor="middle"
            >
              {num(p.valor)}
            </text>
            <text x={px(i)} y={altura - 8} fontSize="9.5" fill={TEXTO} textAnchor="middle">
              {p.rotulo}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** Rosca com o total no centro — acionamentos por posto tarifário. */
export function Rosca({ segmentos, rotuloCentro, tamanho = 150, espessura = 18 }) {
  const total = segmentos.reduce((s, seg) => s + seg.valor, 0);
  const c = tamanho / 2;
  const r = c - 8 - espessura / 2;
  const perimetro = 2 * Math.PI * r;

  let acumulado = 0;
  const arcos = segmentos.map((seg, i) => {
    const comprimento = total ? (perimetro * seg.valor) / total : 0;
    const arco = (
      <circle
        key={i}
        cx={c}
        cy={c}
        r={r}
        fill="none"
        stroke={seg.cor}
        strokeWidth={espessura}
        strokeDasharray={`${comprimento.toFixed(2)} ${(perimetro - comprimento).toFixed(2)}`}
        strokeDashoffset={-acumulado}
        transform={`rotate(-90 ${c} ${c})`}
      />
    );
    acumulado += comprimento;
    return arco;
  });

  return (
    <svg viewBox={`0 0 ${tamanho} ${tamanho}`} className="svg-fluido">
      <circle cx={c} cy={c} r={r} fill="none" stroke="#EEF1F6" strokeWidth={espessura} />
      {arcos}
      <text x={c} y={c + 2} fontSize="25" fontWeight="700" fill={NAVY} textAnchor="middle">
        {num(total)}
      </text>
      <text x={c} y={c + 17} fontSize="10" fill={TEXTO} textAnchor="middle">
        {rotuloCentro}
      </text>
    </svg>
  );
}

/**
 * Ponteiro do fator de potência.
 * A escala abre só na faixa útil (0,85 a 1,00) — é onde o indicador decide conta:
 * abaixo de 0,92 vira cobrança de reativo.
 */
export function PonteiroFatorPotencia({ fp, largura = 300, altura = 158 }) {
  const cx = largura / 2;
  const cy = 116;
  const R = 90;
  const espessura = 17;
  const limite = fp.limite ?? 0.92;
  const min = fp.escala_min ?? 0.85;
  const max = 1;
  const atencao = limite - 0.02;

  const norm = (v) => Math.max(0, Math.min(1, (v - min) / (max - min)));
  const ang = (v) => Math.PI * (1 - norm(v));
  const ponto = (v, raio) => [cx + raio * Math.cos(ang(v)), cy - raio * Math.sin(ang(v))];

  const arco = (de, ate, cor, chave) => {
    const [x1, y1] = ponto(de, R);
    const [x2, y2] = ponto(ate, R);
    return (
      <path
        key={chave}
        d={`M ${x1.toFixed(1)} ${y1.toFixed(1)} A ${R} ${R} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`}
        fill="none"
        stroke={cor}
        strokeWidth={espessura}
      />
    );
  };

  const [xp, yp] = ponto(fp.medio, R - espessura - 8);

  return (
    <svg viewBox={`0 0 ${largura} ${altura}`} className="svg-fluido">
      {arco(min, atencao, '#D92D20', 'ruim')}
      {arco(atencao, limite, '#F59E0B', 'atencao')}
      {arco(limite, max, '#16A34A', 'ok')}

      {[min, limite, max].map((v) => {
        const [xi, yi] = ponto(v, R - espessura / 2);
        const [xf, yf] = ponto(v, R + espessura / 2);
        const [xt, yt] = ponto(v, R + espessura / 2 + 12);
        return (
          <g key={v}>
            <line x1={xi} y1={yi} x2={xf} y2={yf} stroke="#FFFFFF" strokeWidth="2" />
            <text x={xt} y={yt + 4} fontSize="10" fill={TEXTO} textAnchor="middle">
              {num(v, 2)}
            </text>
          </g>
        );
      })}

      {[
        [fp.minimo, 'mín'],
        [fp.maximo, 'máx'],
      ].map(([valor, rotulo]) => {
        if (valor === undefined || valor === null) return null;
        const [xi, yi] = ponto(valor, R - espessura / 2 - 4);
        const [xf, yf] = ponto(valor, R + espessura / 2 + 4);
        const [xt, yt] = ponto(valor, R + espessura / 2 + 22);
        return (
          <g key={rotulo}>
            <line x1={xi} y1={yi} x2={xf} y2={yf} stroke={NAVY} strokeWidth="2.4" />
            <text x={xt} y={yt + 4} fontSize="9" fill={NAVY} textAnchor="middle">
              {rotulo}
            </text>
          </g>
        );
      })}

      <line x1={cx} y1={cy} x2={xp} y2={yp} stroke={NAVY} strokeWidth="4.5" strokeLinecap="round" />
      <circle cx={cx} cy={cy} r="6.5" fill={NAVY} />
      <text
        x={cx}
        y={cy + 28}
        fontSize="25"
        fontWeight="700"
        fill={fp.medio >= limite ? '#16A34A' : '#D92D20'}
        textAnchor="middle"
      >
        {num(fp.medio, 2)}
      </text>
      <text x={cx} y={cy + 41} fontSize="9.5" fill={TEXTO} textAnchor="middle">
        médio ({fp.tipo_medio})
      </text>
    </svg>
  );
}
