/**
 * Layout do boletim. Template literal puro — sem engine de template.
 * O HTML sai autocontido: CSS embutido e logo em data URI.
 *
 * DATA-DRIVEN: bloco/coluna/campo sem dado (null) é OMITIDO. Sem histórico de 2025 →
 * o comparativo é só "semana atual × semana anterior". "pr" é PROXY (Performance).
 */

import { fmt, esc, variacaoPct, variacaoPp, variacaoInvertida } from './formato.js';
import { graficoLinha, graficoRosca, graficoBarras } from './graficos.js';

/** Cartões de KPI (só os que têm dado); barra de meta só quando há referência. */
export function montarKpis(d) {
  const { semana: sem = {}, metas: met = {}, acumulado: acu = {} } = d;

  const barra = (valor, referencia) => {
    const tem = referencia != null && referencia > 0;
    return {
      pct: tem ? Math.min(valor / referencia, 1) * 100 : 0,
      classe: tem ? (valor >= referencia ? 'ok' : 'alerta') : 'ok',
      temBarra: tem,
    };
  };

  const kpis = [];
  if (sem.geracao_mwh != null) {
    kpis.push({
      rotulo: 'Energia gerada', valor: fmt(sem.geracao_mwh, 1), unidade: 'MWh',
      ...barra(sem.geracao_mwh, sem.esperada_mwh),
      metaRotulo: 'Esperado:', meta: sem.esperada_mwh != null ? `${fmt(sem.esperada_mwh, 1)} MWh` : null,
    });
  }
  if (sem.disponibilidade != null) {
    kpis.push({
      rotulo: 'Disponibilidade', valor: `${fmt(sem.disponibilidade, 2)}%`, unidade: '',
      ...barra(sem.disponibilidade, met.disponibilidade),
      metaRotulo: 'Meta:', meta: met.disponibilidade != null ? `> ${fmt(met.disponibilidade, 2)}%` : null,
    });
  }
  if (sem.pr != null) {
    kpis.push({
      rotulo: 'Performance', valor: `${fmt(sem.pr, 1)}%`, unidade: '',
      ...barra(sem.pr, met.performance),
      metaRotulo: 'Referência:', meta: met.performance != null ? `> ${fmt(met.performance, 0)}%` : null,
    });
  }
  if (acu.mes_mwh != null) {
    kpis.push({
      rotulo: 'Acumulado do mês', valor: fmt(acu.mes_mwh, 1), unidade: 'MWh',
      ...barra(acu.mes_mwh, met.mes_mwh),
      metaRotulo: 'Meta:', meta: met.mes_mwh != null ? `> ${fmt(met.mes_mwh, 0)} MWh` : null,
    });
  }
  if (acu.ano_mwh != null) {
    kpis.push({
      rotulo: 'Acumulado do ano', valor: fmt(acu.ano_mwh, 1), unidade: 'MWh',
      ...barra(acu.ano_mwh, met.ano_mwh),
      metaRotulo: 'Meta:', meta: met.ano_mwh != null ? `> ${fmt(met.ano_mwh, 0)} MWh` : null,
    });
  }
  return kpis;
}

/** Linhas da tabela comparativa (semana atual × anterior). Só indicadores com dado. */
export function montarComparativo(d) {
  const { semana: sem = {}, semana_anterior: ant = {} } = d;
  const kwp = d.usina.potencia_kwp;
  const rendimento = (mwh) => (kwp ? (mwh * 1000) / kwp : 0);

  const linha = (indicador, a, b, formatador, comparador) => {
    const vs = b != null ? comparador(a, b) : { texto: '—', classe: 'neutro' };
    return {
      indicador,
      semAtual: formatador(a),
      semAnterior: b != null ? formatador(b) : '—',
      varSem: vs.texto,
      varSemClasse: vs.classe,
    };
  };

  const umaCasa = (v) => fmt(v, 1);
  const pctUma = (v) => `${fmt(v, 1)}%`;
  const inteiro = (v) => fmt(v, 0);

  const linhas = [];
  if (sem.geracao_mwh != null) {
    linhas.push(linha('Geração (MWh)', sem.geracao_mwh, ant.geracao_mwh, umaCasa, variacaoPct));
    linhas.push(linha('Yield (kWh/kWp)', rendimento(sem.geracao_mwh), ant.geracao_mwh != null ? rendimento(ant.geracao_mwh) : null, umaCasa, variacaoPct));
  }
  if (sem.disponibilidade != null) linhas.push(linha('Disponibilidade (%)', sem.disponibilidade, ant.disponibilidade, (v) => `${fmt(v, 2)}%`, variacaoPp));
  if (sem.pr != null) linhas.push(linha('Performance (%)', sem.pr, ant.pr, pctUma, variacaoPp));
  if (sem.alarmes != null) linhas.push(linha('Alarmes', sem.alarmes, ant.alarmes, inteiro, variacaoInvertida));
  return linhas;
}

/**
 * Devolve o HTML completo do boletim.
 */
export function montarHtml(d, { css = '', logo = '' } = {}) {
  const kpis = montarKpis(d);
  const comparativo = montarComparativo(d);
  const sev = d.alarmes_severidade || { criticos: 0, nao_criticos: 0 };
  const totalAlarmes = (sev.criticos || 0) + (sev.nao_criticos || 0);
  const pctCriticos = totalAlarmes ? (sev.criticos / totalAlarmes) * 100 : 0;
  const serie = Array.isArray(d.serie_diaria) ? d.serie_diaria : [];
  const temAnterior = serie.some((p) => p.anterior != null);
  const tipos = Array.isArray(d.alarmes_tipo) ? d.alarmes_tipo : [];
  const oc = d.ocorrencias || {};
  const destaques = Array.isArray(d.destaques) ? d.destaques : [];

  const cartaoKpi = (k) => `
        <div class="kpi">
          <div class="rot">${esc(k.rotulo)}</div>
          <div class="val">${k.valor}<span class="un">${esc(k.unidade)}</span></div>
          ${k.temBarra ? `<div class="barra"><span class="${k.classe}" style="width: ${k.pct.toFixed(1)}%"></span></div>` : ''}
          ${k.meta ? `<div class="meta">${esc(k.metaRotulo)} <b>${k.meta}</b></div>` : ''}
        </div>`;

  const linhaComp = (l) => `
          <tr>
            <td class="ind">${esc(l.indicador)}</td>
            <td><b>${l.semAtual}</b></td>
            <td>${l.semAnterior}</td>
            <td><span class="pill ${l.varSemClasse}">${l.varSem}</span></td>
          </tr>`;

  const cartaoOc = (classe, rotulo, ocorr, unidade) =>
    ocorr
      ? `
          <div class="oc ${classe}">
            <div class="rot">${esc(rotulo)}</div>
            <div class="num">${ocorr.qtd} <small>${esc(unidade)}</small></div>
            <div class="det">${esc(ocorr.detalhe || '')}</div>
          </div>`
      : '';

  const ocorrenciasHtml =
    (cartaoOc('critico', 'Falhas críticas', oc.falhas_criticas, 'eventos') +
      cartaoOc('atencao', 'Falhas não críticas', oc.falhas_nao_criticas, 'eventos') +
      cartaoOc('info', 'OS abertas', oc.os_abertas, 'ordens') +
      cartaoOc('ok', 'OS concluídas', oc.os_concluidas, 'ordens')).trim();

  const blocoGrafico = serie.length
    ? `
    <section class="bloco grafico">
      <h2>Geração diária — MWh</h2>
      <div class="legenda">
        <span class="l-atual"><i></i>Realizado</span>
        ${temAnterior ? `<span class="l-ant"><i></i>Ano anterior</span>` : ''}
        <span class="l-esp"><i></i>Esperado (modelo)</span>
      </div>
      ${graficoLinha(serie)}
    </section>`
    : '';

  const blocoAlarmes = `
      <section class="bloco col-6">
        <h2>Alarmes da semana</h2>
        <div class="alarmes-linha">
          <div class="rosca">
            ${graficoRosca(sev.criticos || 0, sev.nao_criticos || 0)}
            <div class="legenda-rosca">
              <div class="c"><i></i>Críticos: <b>${sev.criticos || 0}</b> (${fmt(pctCriticos, 1)}%)</div>
              <div class="n"><i></i>Não críticos: <b>${sev.nao_criticos || 0}</b> (${fmt(100 - pctCriticos, 1)}%)</div>
            </div>
          </div>
          ${tipos.length ? `<div class="barras"><div class="sub-rot">Por tipo</div>${graficoBarras(tipos)}</div>` : ''}
        </div>
      </section>`;

  const blocoOcorrencias = ocorrenciasHtml
    ? `
      <section class="bloco col-6">
        <h2>Ocorrências da semana</h2>
        <div class="ocorrencias">${ocorrenciasHtml}
        </div>
      </section>`
    : '';

  const blocoDestaques = destaques.length
    ? `
    <section class="bloco destaques">
      <h2>Destaques da semana</h2>
      <ul>${destaques.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>
    </section>`
    : '';

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <title>Boletim Semanal da Operação — Aupus Energia</title>
  <style>${css}</style>
</head>
<body>
<div class="pagina">

  <header class="topo">
    <img class="logo" src="${logo}" alt="Aupus Energia">
    <div class="titulo">
      <h1>Boletim Semanal da Operação</h1>
      <p class="sub">${esc(d.usina.nome)} &middot; <strong>${fmt(d.usina.potencia_kwp / 1000, 1)} MWp</strong></p>
    </div>
    <div class="periodo">
      <div class="rot">Semana</div>
      <div class="val">${esc(d.periodo.inicio)} a ${esc(d.periodo.fim)}</div>
      <div class="ger">Relatório gerado em ${esc(d.periodo.gerado_em)}</div>
    </div>
  </header>

  <div class="conteudo">

    <section class="kpis">${kpis.map(cartaoKpi).join('')}
    </section>

    <section class="bloco">
      <h2>Comparativo operacional</h2>
      <table class="comp">
        <thead>
          <tr>
            <th class="ind">Indicador</th>
            <th>Semana atual<small>${esc(d.periodo.inicio)} a ${esc(d.periodo.fim)}</small></th>
            <th>Semana anterior<small>${esc(d.periodo.janela_semana_anterior || '')}</small></th>
            <th>Variação<small>&nbsp;</small></th>
          </tr>
        </thead>
        <tbody>${comparativo.map(linhaComp).join('')}
        </tbody>
      </table>
    </section>
${blocoGrafico}
    <div class="colunas">${blocoAlarmes}${blocoOcorrencias}
    </div>
${blocoDestaques}
    <p class="nota">
      Yield calculado sobre ${fmt(d.usina.potencia_kwp, 0)} kWp instalados &middot;
      variações apuradas automaticamente a partir dos dados do período &middot;
      dados extraídos do Aupus Smart NexON em ${esc(d.periodo.gerado_em)}.
    </p>

  </div>

  <footer class="rodape">
    <div class="marca">Aupus Smart Nex<span>ON</span></div>
    <div class="slogan">Sua operação <span>conectada</span> ao campo</div>
    <div class="site">aupusenergia.com.br</div>
  </footer>

</div>
</body>
</html>
`;
}
