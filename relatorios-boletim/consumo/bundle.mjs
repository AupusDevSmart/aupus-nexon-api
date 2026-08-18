// consumo/RelatorioConsumo.jsx
import React2 from "react";

// consumo/formato.js
function num(valor, casas = 0) {
  if (valor === null || valor === void 0 || Number.isNaN(valor)) return "\u2014";
  return new Intl.NumberFormat("pt-BR", {
    minimumFractionDigits: casas,
    maximumFractionDigits: casas
  }).format(valor);
}
function moeda(valor, casas = 2) {
  return `R$ ${num(valor, casas)}`;
}

// consumo/calculos-consumo.js
var CORES_POSTO = {
  "Fora de ponta": "#16A34A",
  Ponta: "#F59E0B",
  Reservado: "#2563EB"
};
var SEQUENCIA = ["#16A34A", "#F59E0B", "#2563EB"];
function corDoPosto(nome, indice = 0) {
  return CORES_POSTO[nome] ?? SEQUENCIA[indice % SEQUENCIA.length];
}
function horas(decimal) {
  const inteiras = Math.floor(decimal);
  const minutos = Math.round((decimal - inteiras) * 60);
  return `${inteiras}h ${String(minutos).padStart(2, "0")}m`;
}
function calcularPostos(postos) {
  const soma = (campo) => postos.reduce((s, p) => s + (p[campo] ?? 0), 0);
  const totais = {
    consumo: soma("consumo_kwh"),
    tempo: soma("tempo_horas"),
    custo: soma("custo"),
    acionamentos: soma("acionamentos")
  };
  const pct = (valor, total) => total ? valor / total * 100 : 0;
  return {
    totais,
    linhas: postos.map((p, i) => ({
      ...p,
      cor: corDoPosto(p.nome, i),
      pctConsumo: pct(p.consumo_kwh, totais.consumo),
      pctTempo: pct(p.tempo_horas, totais.tempo),
      pctCusto: pct(p.custo, totais.custo),
      pctAcionamentos: pct(p.acionamentos, totais.acionamentos)
    }))
  };
}
function calcularDemanda(demanda) {
  const contratada = demanda.contratada_kw;
  const pontos = demanda.serie.map((p) => ({ ...p, ultrapassou: p.valor > contratada }));
  const maior = demanda.maior_registrada_kw ?? Math.max(...demanda.serie.map((p) => p.valor));
  return {
    contratada,
    pontos,
    maiorRegistrada: maior,
    ultrapassagens: demanda.ultrapassagens ?? pontos.filter((p) => p.ultrapassou).length,
    maiorUltrapassagemPct: contratada ? (maior / contratada - 1) * 100 : 0
  };
}
function calcularEventos(eventos) {
  return {
    linhas: eventos,
    total: eventos.reduce((s, e) => s + e.qtd, 0)
  };
}
function derivar(d) {
  const postos = calcularPostos(d.postos);
  const demanda = calcularDemanda(d.demanda);
  const eventos = calcularEventos(d.eventos);
  return {
    postos,
    demanda,
    eventos,
    tempoTotal: horas(postos.totais.tempo),
    mediaDiaria: d.funcionamento.dias ? horas(postos.totais.tempo / d.funcionamento.dias) : "\u2014"
  };
}

// consumo/graficos-consumo.jsx
import React from "react";
import { jsx, jsxs } from "react/jsx-runtime";
var GRADE = "#E4E9F0";
var TEXTO = "#6B7280";
var NAVY = "#10203C";
var CONTRATADA = "#2563EB";
var ALERTA = "#D92D20";
var LINHA = "#16A34A";
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
function BarraEmpilhada({ segmentos, rodape = "Semana atual", largura = 300, altura = 146 }) {
  const esq = 52;
  const y0 = 12;
  const y1 = altura - 30;
  const total = segmentos.reduce((s, p) => s + p.valor, 0);
  const { topo, ticks } = escala(total);
  const larguraCol = 96;
  const cx = esq + (largura - esq - 14 - larguraCol) / 2 + larguraCol / 2;
  const py = (v) => y1 - v / topo * (y1 - y0);
  let acumulado = 0;
  const fatias = segmentos.map((p) => {
    const yTopo = py(acumulado + p.valor);
    const alturaSeg = py(acumulado) - yTopo;
    acumulado += p.valor;
    return { ...p, yTopo, alturaSeg };
  });
  return /* @__PURE__ */ jsxs("svg", { viewBox: `0 0 ${largura} ${altura}`, className: "svg-fluido", children: [
    ticks.map((t) => /* @__PURE__ */ jsxs("g", { children: [
      /* @__PURE__ */ jsx("line", { x1: esq, y1: py(t), x2: largura - 8, y2: py(t), stroke: GRADE, strokeWidth: "1" }),
      /* @__PURE__ */ jsx("text", { x: esq - 7, y: py(t) + 3.5, fontSize: "10", fill: TEXTO, textAnchor: "end", children: num(t) })
    ] }, t)),
    fatias.map((f) => /* @__PURE__ */ jsxs("g", { children: [
      /* @__PURE__ */ jsx("rect", { x: cx - larguraCol / 2, y: f.yTopo, width: larguraCol, height: f.alturaSeg, fill: f.cor }),
      f.alturaSeg > 10 && /* @__PURE__ */ jsx(
        "text",
        {
          x: cx,
          y: f.yTopo + f.alturaSeg / 2 + 4,
          fontSize: "11.5",
          fontWeight: "700",
          fill: "#FFFFFF",
          textAnchor: "middle",
          children: num(f.valor)
        }
      )
    ] }, f.rotulo)),
    /* @__PURE__ */ jsx("line", { x1: esq, y1, x2: largura - 8, y2: y1, stroke: "#C7D0DC", strokeWidth: "1.4" }),
    /* @__PURE__ */ jsx("text", { x: cx, y: altura - 12, fontSize: "10.5", fill: TEXTO, textAnchor: "middle", children: rodape })
  ] });
}
function Colunas({ itens, largura = 320, altura = 140 }) {
  const esq = 56;
  const y0 = 20;
  const y1 = altura - 30;
  const { topo, ticks } = escala(Math.max(...itens.map((i) => i.valor)));
  const py = (v) => y1 - v / topo * (y1 - y0);
  const passo = (largura - esq - 12) / itens.length;
  const larguraCol = Math.min(passo * 0.52, 56);
  return /* @__PURE__ */ jsxs("svg", { viewBox: `0 0 ${largura} ${altura}`, className: "svg-fluido", children: [
    ticks.map((t) => /* @__PURE__ */ jsxs("g", { children: [
      /* @__PURE__ */ jsx("line", { x1: esq, y1: py(t), x2: largura - 8, y2: py(t), stroke: GRADE, strokeWidth: "1" }),
      /* @__PURE__ */ jsx("text", { x: esq - 7, y: py(t) + 3.5, fontSize: "10", fill: TEXTO, textAnchor: "end", children: num(t) })
    ] }, t)),
    itens.map((item, i) => {
      const cx = esq + passo * (i + 0.5);
      const y = py(item.valor);
      return /* @__PURE__ */ jsxs("g", { children: [
        /* @__PURE__ */ jsx("rect", { x: cx - larguraCol / 2, y, width: larguraCol, height: y1 - y, rx: "2", fill: item.cor }),
        /* @__PURE__ */ jsx("text", { x: cx, y: y - 7, fontSize: "12", fontWeight: "700", fill: NAVY, textAnchor: "middle", children: num(item.valor) }),
        /* @__PURE__ */ jsx("text", { x: cx, y: altura - 12, fontSize: "10", fill: TEXTO, textAnchor: "middle", children: item.rotulo })
      ] }, item.rotulo);
    }),
    /* @__PURE__ */ jsx("line", { x1: esq, y1, x2: largura - 8, y2: y1, stroke: "#C7D0DC", strokeWidth: "1.4" })
  ] });
}
function LinhaDemanda({ pontos, contratada, largura = 720, altura = 124 }) {
  const esq = 46;
  const dir = 44;
  const y0 = 16;
  const y1 = altura - 26;
  const x1 = largura - dir;
  const { topo, ticks } = escala(Math.max(contratada, ...pontos.map((p) => p.valor)));
  const passoX = (x1 - esq) / Math.max(pontos.length - 1, 1);
  const px = (i) => esq + passoX * i;
  const py = (v) => y1 - v / topo * (y1 - y0);
  const caminho = pontos.map((p, i) => `${i === 0 ? "M" : "L"}${px(i).toFixed(1)},${py(p.valor).toFixed(1)}`).join(" ");
  return /* @__PURE__ */ jsxs("svg", { viewBox: `0 0 ${largura} ${altura}`, className: "svg-fluido", children: [
    ticks.map((t) => /* @__PURE__ */ jsxs("g", { children: [
      /* @__PURE__ */ jsx("line", { x1: esq, y1: py(t), x2: x1, y2: py(t), stroke: GRADE, strokeWidth: "1" }),
      /* @__PURE__ */ jsx("text", { x: esq - 7, y: py(t) + 3.5, fontSize: "9.5", fill: TEXTO, textAnchor: "end", children: num(t) })
    ] }, t)),
    /* @__PURE__ */ jsx("line", { x1: esq, y1: py(contratada), x2: x1, y2: py(contratada), stroke: CONTRATADA, strokeWidth: "2", strokeDasharray: "7 5" }),
    /* @__PURE__ */ jsx("text", { x: x1 + 6, y: py(contratada) + 3, fontSize: "11", fontWeight: "700", fill: CONTRATADA, children: num(contratada) }),
    /* @__PURE__ */ jsx("path", { d: caminho, fill: "none", stroke: LINHA, strokeWidth: "2.6", strokeLinejoin: "round", strokeLinecap: "round" }),
    pontos.map((p, i) => {
      const cor = p.ultrapassou ? ALERTA : LINHA;
      return /* @__PURE__ */ jsxs("g", { children: [
        /* @__PURE__ */ jsx(
          "circle",
          {
            cx: px(i),
            cy: py(p.valor),
            r: p.ultrapassou ? 4.6 : 3.6,
            fill: p.ultrapassou ? cor : "#FFFFFF",
            stroke: cor,
            strokeWidth: "2.2"
          }
        ),
        /* @__PURE__ */ jsx(
          "text",
          {
            x: px(i),
            y: py(p.valor) - 10,
            fontSize: "10",
            fontWeight: "700",
            fill: p.ultrapassou ? cor : NAVY,
            textAnchor: "middle",
            children: num(p.valor)
          }
        ),
        /* @__PURE__ */ jsx("text", { x: px(i), y: altura - 8, fontSize: "9.5", fill: TEXTO, textAnchor: "middle", children: p.rotulo })
      ] }, p.rotulo);
    })
  ] });
}
function Rosca({ segmentos, rotuloCentro, tamanho = 150, espessura = 18 }) {
  const total = segmentos.reduce((s, seg) => s + seg.valor, 0);
  const c = tamanho / 2;
  const r = c - 8 - espessura / 2;
  const perimetro = 2 * Math.PI * r;
  let acumulado = 0;
  const arcos = segmentos.map((seg, i) => {
    const comprimento = total ? perimetro * seg.valor / total : 0;
    const arco = /* @__PURE__ */ jsx(
      "circle",
      {
        cx: c,
        cy: c,
        r,
        fill: "none",
        stroke: seg.cor,
        strokeWidth: espessura,
        strokeDasharray: `${comprimento.toFixed(2)} ${(perimetro - comprimento).toFixed(2)}`,
        strokeDashoffset: -acumulado,
        transform: `rotate(-90 ${c} ${c})`
      },
      i
    );
    acumulado += comprimento;
    return arco;
  });
  return /* @__PURE__ */ jsxs("svg", { viewBox: `0 0 ${tamanho} ${tamanho}`, className: "svg-fluido", children: [
    /* @__PURE__ */ jsx("circle", { cx: c, cy: c, r, fill: "none", stroke: "#EEF1F6", strokeWidth: espessura }),
    arcos,
    /* @__PURE__ */ jsx("text", { x: c, y: c + 2, fontSize: "25", fontWeight: "700", fill: NAVY, textAnchor: "middle", children: num(total) }),
    /* @__PURE__ */ jsx("text", { x: c, y: c + 17, fontSize: "10", fill: TEXTO, textAnchor: "middle", children: rotuloCentro })
  ] });
}
function PonteiroFatorPotencia({ fp, largura = 300, altura = 158 }) {
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
    return /* @__PURE__ */ jsx(
      "path",
      {
        d: `M ${x1.toFixed(1)} ${y1.toFixed(1)} A ${R} ${R} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`,
        fill: "none",
        stroke: cor,
        strokeWidth: espessura
      },
      chave
    );
  };
  const [xp, yp] = ponto(fp.medio, R - espessura - 8);
  return /* @__PURE__ */ jsxs("svg", { viewBox: `0 0 ${largura} ${altura}`, className: "svg-fluido", children: [
    arco(min, atencao, "#D92D20", "ruim"),
    arco(atencao, limite, "#F59E0B", "atencao"),
    arco(limite, max, "#16A34A", "ok"),
    [min, limite, max].map((v) => {
      const [xi, yi] = ponto(v, R - espessura / 2);
      const [xf, yf] = ponto(v, R + espessura / 2);
      const [xt, yt] = ponto(v, R + espessura / 2 + 12);
      return /* @__PURE__ */ jsxs("g", { children: [
        /* @__PURE__ */ jsx("line", { x1: xi, y1: yi, x2: xf, y2: yf, stroke: "#FFFFFF", strokeWidth: "2" }),
        /* @__PURE__ */ jsx("text", { x: xt, y: yt + 4, fontSize: "10", fill: TEXTO, textAnchor: "middle", children: num(v, 2) })
      ] }, v);
    }),
    [
      [fp.minimo, "m\xEDn"],
      [fp.maximo, "m\xE1x"]
    ].map(([valor, rotulo]) => {
      if (valor === void 0 || valor === null) return null;
      const [xi, yi] = ponto(valor, R - espessura / 2 - 4);
      const [xf, yf] = ponto(valor, R + espessura / 2 + 4);
      const [xt, yt] = ponto(valor, R + espessura / 2 + 22);
      return /* @__PURE__ */ jsxs("g", { children: [
        /* @__PURE__ */ jsx("line", { x1: xi, y1: yi, x2: xf, y2: yf, stroke: NAVY, strokeWidth: "2.4" }),
        /* @__PURE__ */ jsx("text", { x: xt, y: yt + 4, fontSize: "9", fill: NAVY, textAnchor: "middle", children: rotulo })
      ] }, rotulo);
    }),
    /* @__PURE__ */ jsx("line", { x1: cx, y1: cy, x2: xp, y2: yp, stroke: NAVY, strokeWidth: "4.5", strokeLinecap: "round" }),
    /* @__PURE__ */ jsx("circle", { cx, cy, r: "6.5", fill: NAVY }),
    /* @__PURE__ */ jsx(
      "text",
      {
        x: cx,
        y: cy + 28,
        fontSize: "25",
        fontWeight: "700",
        fill: fp.medio >= limite ? "#16A34A" : "#D92D20",
        textAnchor: "middle",
        children: num(fp.medio, 2)
      }
    ),
    /* @__PURE__ */ jsxs("text", { x: cx, y: cy + 41, fontSize: "9.5", fill: TEXTO, textAnchor: "middle", children: [
      "m\xE9dio (",
      fp.tipo_medio,
      ")"
    ] })
  ] });
}

// consumo/RelatorioConsumo.jsx
import { Fragment, jsx as jsx2, jsxs as jsxs2 } from "react/jsx-runtime";
function Bloco({ n, titulo, className = "", children }) {
  return /* @__PURE__ */ jsxs2("section", { className: `bloco ${className}`, children: [
    /* @__PURE__ */ jsxs2("h2", { children: [
      n && /* @__PURE__ */ jsx2("span", { className: "n", children: n }),
      titulo
    ] }),
    /* @__PURE__ */ jsx2("div", { className: "bloco-corpo", children })
  ] });
}
function Kpi({ rotulo, valor, unidade, texto, meta, barra, nota }) {
  return /* @__PURE__ */ jsxs2("div", { className: "kpi", children: [
    /* @__PURE__ */ jsx2("div", { className: "rot", children: rotulo }),
    /* @__PURE__ */ jsxs2("div", { className: `val${texto ? " texto" : ""}`, children: [
      valor,
      unidade && /* @__PURE__ */ jsx2("span", { className: "un", children: unidade })
    ] }),
    barra ? /* @__PURE__ */ jsxs2(Fragment, { children: [
      /* @__PURE__ */ jsx2("div", { className: "barra", children: /* @__PURE__ */ jsx2("span", { className: barra.classe, style: { width: `${barra.pct.toFixed(1)}%` } }) }),
      /* @__PURE__ */ jsx2("div", { className: "meta", children: meta })
    ] }) : nota && /* @__PURE__ */ jsx2("div", { className: "nota-kpi", children: nota })
  ] });
}
function RelatorioConsumo({ dados, logo }) {
  const d = dados;
  const c = derivar(d);
  const { linhas: postos, totais } = c.postos;
  const meta = d.metas?.disponibilidade;
  const barraDisponibilidade = meta ? {
    pct: Math.min(d.semana.disponibilidade / meta, 1) * 100,
    classe: d.semana.disponibilidade >= meta ? "ok" : "alerta"
  } : null;
  const chave = (p) => /* @__PURE__ */ jsxs2("span", { className: "chave-item", children: [
    /* @__PURE__ */ jsx2("i", { style: { background: p.cor } }),
    p.nome
  ] }, p.nome);
  const celulaPosto = (p) => /* @__PURE__ */ jsxs2("td", { children: [
    /* @__PURE__ */ jsx2("span", { className: "bolinha", style: { background: p.cor } }),
    p.nome
  ] });
  return /* @__PURE__ */ jsxs2("div", { className: "pagina relatorio-consumo", children: [
    /* @__PURE__ */ jsxs2("header", { className: "topo", children: [
      logo && /* @__PURE__ */ jsx2("img", { className: "logo", src: logo, alt: "Aupus Energia" }),
      /* @__PURE__ */ jsxs2("div", { className: "titulo", children: [
        /* @__PURE__ */ jsx2("h1", { children: "Relat\xF3rio de Gest\xE3o de Energia" }),
        /* @__PURE__ */ jsx2("p", { className: "sub", children: "Vis\xE3o semanal" })
      ] }),
      /* @__PURE__ */ jsxs2("div", { className: "cartoes", children: [
        /* @__PURE__ */ jsxs2("div", { className: "cartao", children: [
          /* @__PURE__ */ jsx2("div", { className: "rot", children: "Per\xEDodo da semana" }),
          /* @__PURE__ */ jsx2("div", { className: "val", children: /* @__PURE__ */ jsxs2("b", { children: [
            d.periodo.inicio,
            " a ",
            d.periodo.fim
          ] }) })
        ] }),
        /* @__PURE__ */ jsxs2("div", { className: "cartao", children: [
          /* @__PURE__ */ jsx2("div", { className: "rot", children: "Unidade \xB7 ponto de medi\xE7\xE3o" }),
          /* @__PURE__ */ jsxs2("div", { className: "val", children: [
            /* @__PURE__ */ jsx2("b", { children: d.unidade.nome }),
            " \u2014 ",
            d.unidade.ponto
          ] })
        ] })
      ] })
    ] }),
    /* @__PURE__ */ jsxs2("div", { className: "conteudo", children: [
      /* @__PURE__ */ jsxs2("section", { className: "kpis", children: [
        /* @__PURE__ */ jsx2(Kpi, { rotulo: "Consumo total", valor: num(totais.consumo), unidade: "kWh", nota: "Semana" }),
        /* @__PURE__ */ jsx2(
          Kpi,
          {
            rotulo: "Disponibilidade",
            valor: `${num(d.semana.disponibilidade, 2)}%`,
            barra: barraDisponibilidade,
            meta: meta ? /* @__PURE__ */ jsxs2(Fragment, { children: [
              "Meta: ",
              /* @__PURE__ */ jsxs2("b", { children: [
                "> ",
                num(meta, 2),
                "%"
              ] })
            ] }) : null,
            nota: "Semana"
          }
        ),
        /* @__PURE__ */ jsx2(Kpi, { rotulo: "FIC", valor: String(d.semana.fic), unidade: "interrup\xE7\xF5es", nota: "Semana" }),
        /* @__PURE__ */ jsx2(Kpi, { rotulo: "DIC", valor: d.semana.dic, nota: "Semana" }),
        /* @__PURE__ */ jsx2(Kpi, { rotulo: "Demanda m\xE1xima", valor: num(d.semana.demanda_maxima_kw), unidade: "kW", nota: "Maior da semana" }),
        /* @__PURE__ */ jsx2(Kpi, { rotulo: "Qualidade da tens\xE3o", valor: d.semana.qualidade_tensao.classificacao, texto: true })
      ] }),
      /* @__PURE__ */ jsxs2("div", { className: "faixa", children: [
        /* @__PURE__ */ jsx2("div", { className: "rot", children: "Acumulado do m\xEAs" }),
        /* @__PURE__ */ jsxs2("div", { className: "item", children: [
          "Consumo ",
          /* @__PURE__ */ jsxs2("b", { children: [
            num(d.mes.consumo_kwh),
            " kWh"
          ] })
        ] }),
        /* @__PURE__ */ jsxs2("div", { className: "item", children: [
          "Disponibilidade ",
          /* @__PURE__ */ jsxs2("b", { children: [
            num(d.mes.disponibilidade, 2),
            "%"
          ] })
        ] }),
        /* @__PURE__ */ jsxs2("div", { className: "item", children: [
          "FIC ",
          /* @__PURE__ */ jsx2("b", { children: d.mes.fic })
        ] }),
        /* @__PURE__ */ jsxs2("div", { className: "item", children: [
          "DIC ",
          /* @__PURE__ */ jsx2("b", { children: d.mes.dic })
        ] })
      ] }),
      /* @__PURE__ */ jsxs2("div", { className: "colunas", children: [
        /* @__PURE__ */ jsxs2(Bloco, { n: "1", titulo: "Consumo por posto tarif\xE1rio", className: "col-3", children: [
          /* @__PURE__ */ jsx2("div", { className: "chave", children: postos.map(chave) }),
          /* @__PURE__ */ jsx2(BarraEmpilhada, { segmentos: postos.map((p) => ({ rotulo: p.nome, valor: p.consumo_kwh, cor: p.cor })) }),
          /* @__PURE__ */ jsxs2("table", { className: "dados", children: [
            /* @__PURE__ */ jsx2("thead", { children: /* @__PURE__ */ jsxs2("tr", { children: [
              /* @__PURE__ */ jsx2("th", { children: "Posto tarif\xE1rio" }),
              /* @__PURE__ */ jsx2("th", { children: "kWh" }),
              /* @__PURE__ */ jsx2("th", { children: "Part." })
            ] }) }),
            /* @__PURE__ */ jsxs2("tbody", { children: [
              postos.map((p) => /* @__PURE__ */ jsxs2("tr", { children: [
                celulaPosto(p),
                /* @__PURE__ */ jsx2("td", { children: /* @__PURE__ */ jsx2("b", { children: num(p.consumo_kwh) }) }),
                /* @__PURE__ */ jsxs2("td", { children: [
                  num(p.pctConsumo, 1),
                  "%"
                ] })
              ] }, p.nome)),
              /* @__PURE__ */ jsxs2("tr", { className: "total", children: [
                /* @__PURE__ */ jsx2("td", { children: "Total" }),
                /* @__PURE__ */ jsx2("td", { children: num(totais.consumo) }),
                /* @__PURE__ */ jsx2("td", { children: "100%" })
              ] })
            ] })
          ] })
        ] }),
        /* @__PURE__ */ jsxs2(Bloco, { n: "2", titulo: "Tempo de uso", className: "col-3", children: [
          /* @__PURE__ */ jsxs2("table", { className: "dados", children: [
            /* @__PURE__ */ jsx2("thead", { children: /* @__PURE__ */ jsxs2("tr", { children: [
              /* @__PURE__ */ jsx2("th", { children: "Posto tarif\xE1rio" }),
              /* @__PURE__ */ jsx2("th", { children: "Tempo" }),
              /* @__PURE__ */ jsx2("th", { children: "% do tempo" })
            ] }) }),
            /* @__PURE__ */ jsxs2("tbody", { children: [
              postos.map((p) => /* @__PURE__ */ jsxs2("tr", { children: [
                celulaPosto(p),
                /* @__PURE__ */ jsx2("td", { children: /* @__PURE__ */ jsx2("b", { children: p.tempo }) }),
                /* @__PURE__ */ jsxs2("td", { children: [
                  num(p.pctTempo, 1),
                  "%"
                ] })
              ] }, p.nome)),
              /* @__PURE__ */ jsxs2("tr", { className: "total", children: [
                /* @__PURE__ */ jsx2("td", { children: "Total" }),
                /* @__PURE__ */ jsx2("td", { children: c.tempoTotal }),
                /* @__PURE__ */ jsx2("td", { children: "100%" })
              ] })
            ] })
          ] }),
          /* @__PURE__ */ jsxs2("div", { className: "destaque", children: [
            /* @__PURE__ */ jsx2("div", { className: "rot", children: "M\xE9dia di\xE1ria de uso" }),
            /* @__PURE__ */ jsx2("div", { className: "val", children: c.mediaDiaria }),
            /* @__PURE__ */ jsxs2("div", { className: "det", children: [
              "em ",
              d.funcionamento.dias,
              " dias de opera\xE7\xE3o"
            ] })
          ] })
        ] }),
        /* @__PURE__ */ jsxs2(Bloco, { n: "3", titulo: "Custo previsto da energia", className: "col-3", children: [
          /* @__PURE__ */ jsx2("div", { className: "chave", children: postos.map(chave) }),
          /* @__PURE__ */ jsx2(Colunas, { itens: postos.map((p) => ({ rotulo: p.nome, valor: p.custo, cor: p.cor })) }),
          /* @__PURE__ */ jsxs2("table", { className: "dados", children: [
            /* @__PURE__ */ jsx2("thead", { children: /* @__PURE__ */ jsxs2("tr", { children: [
              /* @__PURE__ */ jsx2("th", { children: "Posto tarif\xE1rio" }),
              /* @__PURE__ */ jsx2("th", { children: "Custo (R$)" }),
              /* @__PURE__ */ jsx2("th", { children: "Part." })
            ] }) }),
            /* @__PURE__ */ jsxs2("tbody", { children: [
              postos.map((p) => /* @__PURE__ */ jsxs2("tr", { children: [
                celulaPosto(p),
                /* @__PURE__ */ jsx2("td", { children: /* @__PURE__ */ jsx2("b", { children: num(p.custo, 2) }) }),
                /* @__PURE__ */ jsxs2("td", { children: [
                  num(p.pctCusto, 1),
                  "%"
                ] })
              ] }, p.nome)),
              /* @__PURE__ */ jsxs2("tr", { className: "total", children: [
                /* @__PURE__ */ jsx2("td", { children: "Total" }),
                /* @__PURE__ */ jsx2("td", { children: num(totais.custo, 2) }),
                /* @__PURE__ */ jsx2("td", { children: "100%" })
              ] })
            ] })
          ] })
        ] })
      ] }),
      /* @__PURE__ */ jsxs2("div", { className: "colunas", children: [
        /* @__PURE__ */ jsxs2(Bloco, { n: "4", titulo: "Demanda contratada \xD7 demanda m\xE1xima di\xE1ria (kW)", className: "col-demanda", children: [
          /* @__PURE__ */ jsxs2("div", { className: "chave", children: [
            /* @__PURE__ */ jsxs2("span", { className: "chave-item", children: [
              /* @__PURE__ */ jsx2("i", { style: { background: "#16A34A" } }),
              "M\xE1xima di\xE1ria"
            ] }),
            /* @__PURE__ */ jsxs2("span", { className: "chave-item", children: [
              /* @__PURE__ */ jsx2("i", { style: { background: "#2563EB" } }),
              "Contratada"
            ] }),
            /* @__PURE__ */ jsxs2("span", { className: "chave-item", children: [
              /* @__PURE__ */ jsx2("i", { style: { background: "#D92D20" } }),
              "Acima do contrato"
            ] })
          ] }),
          /* @__PURE__ */ jsx2(LinhaDemanda, { pontos: c.demanda.pontos, contratada: c.demanda.contratada })
        ] }),
        /* @__PURE__ */ jsx2(Bloco, { n: "5", titulo: "An\xE1lise de demanda", className: "col-ficha", children: /* @__PURE__ */ jsx2("table", { className: "dados ficha", children: /* @__PURE__ */ jsxs2("tbody", { children: [
          /* @__PURE__ */ jsxs2("tr", { children: [
            /* @__PURE__ */ jsx2("td", { children: "Demanda contratada" }),
            /* @__PURE__ */ jsxs2("td", { children: [
              num(c.demanda.contratada),
              " kW"
            ] })
          ] }),
          /* @__PURE__ */ jsxs2("tr", { children: [
            /* @__PURE__ */ jsx2("td", { children: "Maior demanda registrada" }),
            /* @__PURE__ */ jsxs2("td", { className: "alerta", children: [
              num(c.demanda.maiorRegistrada),
              " kW"
            ] })
          ] }),
          /* @__PURE__ */ jsxs2("tr", { children: [
            /* @__PURE__ */ jsx2("td", { children: "Data do pico" }),
            /* @__PURE__ */ jsx2("td", { children: d.demanda.data_pico })
          ] }),
          /* @__PURE__ */ jsxs2("tr", { children: [
            /* @__PURE__ */ jsx2("td", { children: "Perman\xEAncia no pico" }),
            /* @__PURE__ */ jsx2("td", { children: d.demanda.permanencia_pico })
          ] }),
          /* @__PURE__ */ jsxs2("tr", { children: [
            /* @__PURE__ */ jsx2("td", { children: "N\xBA de ultrapassagens" }),
            /* @__PURE__ */ jsx2("td", { children: c.demanda.ultrapassagens })
          ] }),
          /* @__PURE__ */ jsxs2("tr", { children: [
            /* @__PURE__ */ jsx2("td", { children: "Maior ultrapassagem" }),
            /* @__PURE__ */ jsxs2("td", { className: "alerta", children: [
              num(c.demanda.maiorUltrapassagemPct, 1),
              "%"
            ] })
          ] })
        ] }) }) })
      ] }),
      /* @__PURE__ */ jsx2(Bloco, { n: "6", titulo: "Indicadores de qualidade da energia", children: /* @__PURE__ */ jsxs2("div", { className: "lado-a-lado", children: [
        /* @__PURE__ */ jsx2("div", { className: "lado-tabela", children: /* @__PURE__ */ jsxs2("table", { className: "dados", children: [
          /* @__PURE__ */ jsx2("thead", { children: /* @__PURE__ */ jsxs2("tr", { children: [
            /* @__PURE__ */ jsx2("th", { children: "Indicador" }),
            /* @__PURE__ */ jsx2("th", { children: "Valor" }),
            /* @__PURE__ */ jsx2("th", { children: "Limite recom." }),
            /* @__PURE__ */ jsx2("th", { className: "centro", children: "Status" })
          ] }) }),
          /* @__PURE__ */ jsx2("tbody", { children: d.qualidade.indicadores.map((i) => /* @__PURE__ */ jsxs2("tr", { children: [
            /* @__PURE__ */ jsx2("td", { children: i.indicador }),
            /* @__PURE__ */ jsx2("td", { children: /* @__PURE__ */ jsx2("b", { children: i.valor }) }),
            /* @__PURE__ */ jsx2("td", { children: i.limite }),
            /* @__PURE__ */ jsx2("td", { className: "centro", children: /* @__PURE__ */ jsx2("span", { className: `dot ${i.status}` }) })
          ] }, i.indicador)) })
        ] }) }),
        /* @__PURE__ */ jsxs2("div", { className: "lado-svg fp", children: [
          /* @__PURE__ */ jsx2("div", { className: "sub-rot", children: "Fator de pot\xEAncia" }),
          /* @__PURE__ */ jsx2(PonteiroFatorPotencia, { fp: d.qualidade.fator_potencia }),
          /* @__PURE__ */ jsxs2("div", { className: "fp-resumo", children: [
            "M\xEDn ",
            /* @__PURE__ */ jsx2("b", { children: num(d.qualidade.fator_potencia.minimo, 2) }),
            " \xB7 M\xE1x",
            " ",
            /* @__PURE__ */ jsx2("b", { children: num(d.qualidade.fator_potencia.maximo, 2) }),
            " \xB7 Limite",
            " ",
            /* @__PURE__ */ jsxs2("b", { children: [
              "\u2265 ",
              num(d.qualidade.fator_potencia.limite, 2)
            ] })
          ] })
        ] })
      ] }) }),
      /* @__PURE__ */ jsx2(Bloco, { n: "7", titulo: "Alarmes e ocorr\xEAncias", children: /* @__PURE__ */ jsxs2("div", { className: "alarmes", children: [
        /* @__PURE__ */ jsxs2("div", { className: "alarmes-rosca", children: [
          /* @__PURE__ */ jsx2("div", { className: "sub-rot", children: "Acionamentos por posto" }),
          /* @__PURE__ */ jsxs2("div", { className: "rosca-linha", children: [
            /* @__PURE__ */ jsx2("div", { className: "rosca-svg", children: /* @__PURE__ */ jsx2(
              Rosca,
              {
                segmentos: postos.map((p) => ({ valor: p.acionamentos, cor: p.cor })),
                rotuloCentro: "acionamentos"
              }
            ) }),
            /* @__PURE__ */ jsx2("div", { className: "rosca-chave", children: postos.map((p) => /* @__PURE__ */ jsxs2("div", { children: [
              /* @__PURE__ */ jsx2("i", { style: { background: p.cor } }),
              p.nome,
              /* @__PURE__ */ jsx2("br", {}),
              /* @__PURE__ */ jsx2("b", { children: p.acionamentos }),
              " (",
              num(p.pctAcionamentos, 1),
              "%)"
            ] }, p.nome)) })
          ] })
        ] }),
        /* @__PURE__ */ jsxs2("div", { className: "alarmes-eventos", children: [
          /* @__PURE__ */ jsx2("div", { className: "sub-rot", children: "Eventos registrados" }),
          /* @__PURE__ */ jsxs2("table", { className: "dados", children: [
            /* @__PURE__ */ jsx2("thead", { children: /* @__PURE__ */ jsxs2("tr", { children: [
              /* @__PURE__ */ jsx2("th", { children: "Evento" }),
              /* @__PURE__ */ jsx2("th", { children: "Qtd." }),
              /* @__PURE__ */ jsx2("th", { className: "centro", children: "Sev." })
            ] }) }),
            /* @__PURE__ */ jsxs2("tbody", { children: [
              c.eventos.linhas.map((e) => /* @__PURE__ */ jsxs2("tr", { children: [
                /* @__PURE__ */ jsx2("td", { children: e.evento }),
                /* @__PURE__ */ jsx2("td", { children: /* @__PURE__ */ jsx2("b", { children: e.qtd }) }),
                /* @__PURE__ */ jsx2("td", { className: "centro", children: /* @__PURE__ */ jsx2("span", { className: `dot ${e.severidade === "alta" ? "critico" : "atencao"}` }) })
              ] }, e.evento)),
              /* @__PURE__ */ jsxs2("tr", { className: "total", children: [
                /* @__PURE__ */ jsx2("td", { children: "Total" }),
                /* @__PURE__ */ jsx2("td", { children: c.eventos.total }),
                /* @__PURE__ */ jsx2("td", {})
              ] })
            ] })
          ] })
        ] }),
        d.oportunidade && /* @__PURE__ */ jsxs2("div", { className: "economia", children: [
          /* @__PURE__ */ jsx2("div", { className: "rot", children: d.oportunidade.titulo }),
          /* @__PURE__ */ jsx2("p", { children: d.oportunidade.texto }),
          /* @__PURE__ */ jsx2("div", { className: "valor", children: moeda(d.oportunidade.valor) })
        ] })
      ] }) }),
      /* @__PURE__ */ jsxs2("p", { className: "nota", children: [
        "Demanda apurada em ",
        d.periodo.referencia_demanda,
        " \xB7 participa\xE7\xF5es, totais e ultrapassagens calculados a partir dos dados do per\xEDodo \xB7 gerado em ",
        d.periodo.gerado_em,
        "."
      ] })
    ] }),
    /* @__PURE__ */ jsxs2("footer", { className: "rodape", children: [
      /* @__PURE__ */ jsxs2("div", { className: "marca", children: [
        "Aupus Smart Nex",
        /* @__PURE__ */ jsx2("span", { children: "ON" })
      ] }),
      /* @__PURE__ */ jsxs2("div", { className: "slogan", children: [
        "Sua opera\xE7\xE3o ",
        /* @__PURE__ */ jsx2("span", { children: "conectada" }),
        " ao campo"
      ] }),
      /* @__PURE__ */ jsx2("div", { className: "site", children: "aupusenergia.com.br" })
    ] })
  ] });
}
export {
  RelatorioConsumo as default
};
