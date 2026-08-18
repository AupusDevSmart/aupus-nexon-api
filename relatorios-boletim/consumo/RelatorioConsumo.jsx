/**
 * Relatório de Gestão de Energia — Visão Semanal
 *
 * Componente único, sem estado e sem efeitos: recebe o payload da plataforma e devolve a
 * página em A4. Serve para exibir na tela e para virar PDF (o mesmo markup é impresso).
 * Números derivados ficam em calculos-consumo.js.
 */

import React from 'react';
import { num, moeda } from './formato.js';
import { derivar } from './calculos-consumo.js';
import { BarraEmpilhada, Colunas, LinhaDemanda, Rosca, PonteiroFatorPotencia } from './graficos-consumo.jsx';

function Bloco({ n, titulo, className = '', children }) {
  return (
    <section className={`bloco ${className}`}>
      <h2>
        {n && <span className="n">{n}</span>}
        {titulo}
      </h2>
      <div className="bloco-corpo">{children}</div>
    </section>
  );
}

function Kpi({ rotulo, valor, unidade, texto, meta, barra, nota }) {
  return (
    <div className="kpi">
      <div className="rot">{rotulo}</div>
      <div className={`val${texto ? ' texto' : ''}`}>
        {valor}
        {unidade && <span className="un">{unidade}</span>}
      </div>
      {barra ? (
        <>
          <div className="barra">
            <span className={barra.classe} style={{ width: `${barra.pct.toFixed(1)}%` }} />
          </div>
          <div className="meta">{meta}</div>
        </>
      ) : (
        nota && <div className="nota-kpi">{nota}</div>
      )}
    </div>
  );
}

export default function RelatorioConsumo({ dados, logo }) {
  const d = dados;
  const c = derivar(d);
  const { linhas: postos, totais } = c.postos;

  const meta = d.metas?.disponibilidade;
  const barraDisponibilidade = meta
    ? {
        pct: Math.min(d.semana.disponibilidade / meta, 1) * 100,
        classe: d.semana.disponibilidade >= meta ? 'ok' : 'alerta',
      }
    : null;

  const chave = (p) => (
    <span key={p.nome} className="chave-item">
      <i style={{ background: p.cor }} />
      {p.nome}
    </span>
  );

  const celulaPosto = (p) => (
    <td>
      <span className="bolinha" style={{ background: p.cor }} />
      {p.nome}
    </td>
  );

  return (
    <div className="pagina relatorio-consumo">
      <header className="topo">
        {logo && <img className="logo" src={logo} alt="Aupus Energia" />}
        <div className="titulo">
          <h1>Relatório de Gestão de Energia</h1>
          <p className="sub">Visão semanal</p>
        </div>
        <div className="cartoes">
          <div className="cartao">
            <div className="rot">Período da semana</div>
            <div className="val">
              <b>
                {d.periodo.inicio} a {d.periodo.fim}
              </b>
            </div>
          </div>
          <div className="cartao">
            <div className="rot">Unidade · ponto de medição</div>
            <div className="val">
              <b>{d.unidade.nome}</b> — {d.unidade.ponto}
            </div>
          </div>
        </div>
      </header>

      <div className="conteudo">
        <section className="kpis">
          <Kpi rotulo="Consumo total" valor={num(totais.consumo)} unidade="kWh" nota="Semana" />
          <Kpi
            rotulo="Disponibilidade"
            valor={`${num(d.semana.disponibilidade, 2)}%`}
            barra={barraDisponibilidade}
            meta={
              meta ? (
                <>
                  Meta: <b>&gt; {num(meta, 2)}%</b>
                </>
              ) : null
            }
            nota="Semana"
          />
          <Kpi rotulo="FIC" valor={String(d.semana.fic)} unidade="interrupções" nota="Semana" />
          <Kpi rotulo="DIC" valor={d.semana.dic} nota="Semana" />
          <Kpi rotulo="Demanda máxima" valor={num(d.semana.demanda_maxima_kw)} unidade="kW" nota="Maior da semana" />
          <Kpi rotulo="Qualidade da tensão" valor={d.semana.qualidade_tensao.classificacao} texto />
        </section>

        <div className="faixa">
          <div className="rot">Acumulado do mês</div>
          <div className="item">
            Consumo <b>{num(d.mes.consumo_kwh)} kWh</b>
          </div>
          <div className="item">
            Disponibilidade <b>{num(d.mes.disponibilidade, 2)}%</b>
          </div>
          <div className="item">
            FIC <b>{d.mes.fic}</b>
          </div>
          <div className="item">
            DIC <b>{d.mes.dic}</b>
          </div>
        </div>

        <div className="colunas">
          <Bloco n="1" titulo="Consumo por posto tarifário" className="col-3">
            <div className="chave">{postos.map(chave)}</div>
            <BarraEmpilhada segmentos={postos.map((p) => ({ rotulo: p.nome, valor: p.consumo_kwh, cor: p.cor }))} />
            <table className="dados">
              <thead>
                <tr>
                  <th>Posto tarifário</th>
                  <th>kWh</th>
                  <th>Part.</th>
                </tr>
              </thead>
              <tbody>
                {postos.map((p) => (
                  <tr key={p.nome}>
                    {celulaPosto(p)}
                    <td>
                      <b>{num(p.consumo_kwh)}</b>
                    </td>
                    <td>{num(p.pctConsumo, 1)}%</td>
                  </tr>
                ))}
                <tr className="total">
                  <td>Total</td>
                  <td>{num(totais.consumo)}</td>
                  <td>100%</td>
                </tr>
              </tbody>
            </table>
          </Bloco>

          <Bloco n="2" titulo="Tempo de uso" className="col-3">
            <table className="dados">
              <thead>
                <tr>
                  <th>Posto tarifário</th>
                  <th>Tempo</th>
                  <th>% do tempo</th>
                </tr>
              </thead>
              <tbody>
                {postos.map((p) => (
                  <tr key={p.nome}>
                    {celulaPosto(p)}
                    <td>
                      <b>{p.tempo}</b>
                    </td>
                    <td>{num(p.pctTempo, 1)}%</td>
                  </tr>
                ))}
                <tr className="total">
                  <td>Total</td>
                  <td>{c.tempoTotal}</td>
                  <td>100%</td>
                </tr>
              </tbody>
            </table>
            <div className="destaque">
              <div className="rot">Média diária de uso</div>
              <div className="val">{c.mediaDiaria}</div>
              <div className="det">em {d.funcionamento.dias} dias de operação</div>
            </div>
          </Bloco>

          <Bloco n="3" titulo="Custo previsto da energia" className="col-3">
            <div className="chave">{postos.map(chave)}</div>
            <Colunas itens={postos.map((p) => ({ rotulo: p.nome, valor: p.custo, cor: p.cor }))} />
            <table className="dados">
              <thead>
                <tr>
                  <th>Posto tarifário</th>
                  <th>Custo (R$)</th>
                  <th>Part.</th>
                </tr>
              </thead>
              <tbody>
                {postos.map((p) => (
                  <tr key={p.nome}>
                    {celulaPosto(p)}
                    <td>
                      <b>{num(p.custo, 2)}</b>
                    </td>
                    <td>{num(p.pctCusto, 1)}%</td>
                  </tr>
                ))}
                <tr className="total">
                  <td>Total</td>
                  <td>{num(totais.custo, 2)}</td>
                  <td>100%</td>
                </tr>
              </tbody>
            </table>
          </Bloco>
        </div>

        <div className="colunas">
          <Bloco n="4" titulo="Demanda contratada × demanda máxima diária (kW)" className="col-demanda">
            <div className="chave">
              <span className="chave-item">
                <i style={{ background: '#16A34A' }} />
                Máxima diária
              </span>
              <span className="chave-item">
                <i style={{ background: '#2563EB' }} />
                Contratada
              </span>
              <span className="chave-item">
                <i style={{ background: '#D92D20' }} />
                Acima do contrato
              </span>
            </div>
            <LinhaDemanda pontos={c.demanda.pontos} contratada={c.demanda.contratada} />
          </Bloco>

          <Bloco n="5" titulo="Análise de demanda" className="col-ficha">
            <table className="dados ficha">
              <tbody>
                <tr>
                  <td>Demanda contratada</td>
                  <td>{num(c.demanda.contratada)} kW</td>
                </tr>
                <tr>
                  <td>Maior demanda registrada</td>
                  <td className="alerta">{num(c.demanda.maiorRegistrada)} kW</td>
                </tr>
                <tr>
                  <td>Data do pico</td>
                  <td>{d.demanda.data_pico}</td>
                </tr>
                <tr>
                  <td>Permanência no pico</td>
                  <td>{d.demanda.permanencia_pico}</td>
                </tr>
                <tr>
                  <td>Nº de ultrapassagens</td>
                  <td>{c.demanda.ultrapassagens}</td>
                </tr>
                <tr>
                  <td>Maior ultrapassagem</td>
                  <td className="alerta">{num(c.demanda.maiorUltrapassagemPct, 1)}%</td>
                </tr>
              </tbody>
            </table>
          </Bloco>
        </div>

        <Bloco n="6" titulo="Indicadores de qualidade da energia">
          <div className="lado-a-lado">
            <div className="lado-tabela">
              <table className="dados">
                <thead>
                  <tr>
                    <th>Indicador</th>
                    <th>Valor</th>
                    <th>Limite recom.</th>
                    <th className="centro">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {d.qualidade.indicadores.map((i) => (
                    <tr key={i.indicador}>
                      <td>{i.indicador}</td>
                      <td>
                        <b>{i.valor}</b>
                      </td>
                      <td>{i.limite}</td>
                      <td className="centro">
                        <span className={`dot ${i.status}`} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="lado-svg fp">
              <div className="sub-rot">Fator de potência</div>
              <PonteiroFatorPotencia fp={d.qualidade.fator_potencia} />
              <div className="fp-resumo">
                Mín <b>{num(d.qualidade.fator_potencia.minimo, 2)}</b> · Máx{' '}
                <b>{num(d.qualidade.fator_potencia.maximo, 2)}</b> · Limite{' '}
                <b>≥ {num(d.qualidade.fator_potencia.limite, 2)}</b>
              </div>
            </div>
          </div>
        </Bloco>

        <Bloco n="7" titulo="Alarmes e ocorrências">
          <div className="alarmes">
            <div className="alarmes-rosca">
              <div className="sub-rot">Acionamentos por posto</div>
              <div className="rosca-linha">
                <div className="rosca-svg">
                  <Rosca
                    segmentos={postos.map((p) => ({ valor: p.acionamentos, cor: p.cor }))}
                    rotuloCentro="acionamentos"
                  />
                </div>
                <div className="rosca-chave">
                  {postos.map((p) => (
                    <div key={p.nome}>
                      <i style={{ background: p.cor }} />
                      {p.nome}
                      <br />
                      <b>{p.acionamentos}</b> ({num(p.pctAcionamentos, 1)}%)
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="alarmes-eventos">
              <div className="sub-rot">Eventos registrados</div>
              <table className="dados">
                <thead>
                  <tr>
                    <th>Evento</th>
                    <th>Qtd.</th>
                    <th className="centro">Sev.</th>
                  </tr>
                </thead>
                <tbody>
                  {c.eventos.linhas.map((e) => (
                    <tr key={e.evento}>
                      <td>{e.evento}</td>
                      <td>
                        <b>{e.qtd}</b>
                      </td>
                      <td className="centro">
                        <span className={`dot ${e.severidade === 'alta' ? 'critico' : 'atencao'}`} />
                      </td>
                    </tr>
                  ))}
                  <tr className="total">
                    <td>Total</td>
                    <td>{c.eventos.total}</td>
                    <td />
                  </tr>
                </tbody>
              </table>
            </div>

            {d.oportunidade && (
              <div className="economia">
                <div className="rot">{d.oportunidade.titulo}</div>
                <p>{d.oportunidade.texto}</p>
                <div className="valor">{moeda(d.oportunidade.valor)}</div>
              </div>
            )}
          </div>
        </Bloco>

        <p className="nota">
          Demanda apurada em {d.periodo.referencia_demanda} · participações, totais e ultrapassagens calculados a partir
          dos dados do período · gerado em {d.periodo.gerado_em}.
        </p>
      </div>

      <footer className="rodape">
        <div className="marca">
          Aupus Smart Nex<span>ON</span>
        </div>
        <div className="slogan">
          Sua operação <span>conectada</span> ao campo
        </div>
        <div className="site">aupusenergia.com.br</div>
      </footer>
    </div>
  );
}
