# Análise de geração (NEXON-16)

Spec: card NEXON-16 ("Spec NexON — Análise de geração"). Vale para web e apps.
Módulo: `src/modules/geracao-analise/`. SQL: `db/manual-migrations/2026-10-20_geracao_analise.sql` e
`2026-10-21_fonte_geracao.sql` (fonte da geração, NEXON-37 — ver a seção "Fonte da geração").

A análise olha **só os inversores** da instalação (GER-2). Carga, medidor e líquido continuam
vindo dos endpoints de sempre.

## Endpoints (prefixo `/api/v1`, JWT; resposta no envelope `{success, data}` de sempre)

### `GET /geracao-analise/unidades/:unidadeId?periodo=dia|semana|mes|ano|total&data=YYYY-MM-DD`

Qualquer usuário com acesso à instalação. `data` = qualquer dia dentro do período (padrão: hoje,
fuso America/Sao_Paulo). Semana = segunda a domingo.

```jsonc
{
  "unidade_id": "cmh...", "unidade_nome": "UFV SOLAR POWER",
  "periodo": "dia",                    // dia | semana | mes | ano | total
  "referencia": "2026-10-20",          // a data pedida (normalizada)
  "inicio": "2026-10-20", "fim": "2026-10-20",   // primeiro e último dia do período
  "anterior": "2026-10-19", "proximo": null,     // data para < e > (null = futuro, não navega; Total: os dois null)
  "hoje": "2026-10-20",
  "config": {
    "fonte": "satelite",               // satelite | solarimetro | nenhuma
    "kwp_dc": 1512, "potencia_ac_kw": 999,
    "exibir_rs": false, "tarifa_rs_kwh": null,  // tarifa só vem quando exibir_rs = true
    "fonte_geracao": "automatico"      // automatico | ton | nuvem (NEXON-37)
  },
  "fonte_geracao": {                   // NEXON-37 — de onde veio o kWh do período (ver "Fonte da geração")
    "config": "automatico",
    "escolhida": "ton",                // ton | nuvem | manual | mista | null (período sem dado)
    "divergem": false,                 // algum dia do período com motivo "divergem"
    "selo": "Fonte: TON",              // "Fonte: TON" | "Fonte: nuvem" | "Fonte: manual" | "Fontes: TON e nuvem"
                                       //   | "Fontes divergem — usando TON" | null (sem dado)
    "tem_nuvem": true,                 // integração de nuvem ativa (unidade_fv_config.ativo)
    "kwh_ton": 6100.2, "kwh_nuvem": 6080.0,     // somas do período (null sem dado)
    "dias": [                          // Dia: 1 item; Semana/Mês: 1 por dia até hoje; Ano/Total: omitido
      { "data": "2026-10-20", "kwh": 6100.2, "kwh_ton": 6100.2, "kwh_nuvem": 6080.0, "kwh_manual": null,
        "fonte": "ton", "motivo": "concordam", "divergencia_pct": 0.3 }
    ]
  },
  "tem_inversor": true,                // false = instalação sem geração (não mostrar a análise)
  "tem_dados": true,                   // false = inversores nunca mandaram leitura → pontos vazio e
                                       //   resumo/perdas/fechamento/previsao null (mostrar o gráfico antigo)
  "agora": {                           // só em periodo=dia e data=hoje
    "potencia_kw": 0.0,                // soma dos inversores na última leitura (≤ 15 min)
    "gerando": false                   // false depois do pôr do sol → destacar o resumo do dia (GER-24)
  },
  // Dia: 96 pontos de 15 min. Semana/Mês: 1 por dia. Ano: 1 por mês. Total: 1 por ano (do primeiro
  //   ano com dado em qualquer fonte, ≥ 2020, até o atual; rotulo "2025", data "2025-01-01").
  "pontos": [
    {
      "rotulo": "06:15",               // Dia "HH:mm" · Semana "seg 20" · Mês "20" · Ano "out"
      "data": "2026-10-20",            // dia (semana/mês) ou "YYYY-MM-01" (ano); no Dia, o dia
      "inicio": "2026-10-20T06:15:00-03:00",   // só no Dia
      "real_kw": 12.3,                 // só no Dia: potência média do intervalo; null = sem dado
      "esperado_kw": 15.1,             // só no Dia; null = sem irradiância ainda (GER-12) ou fonte nenhuma
      "real_kwh": 3.07,                // energia do ponto; null = sem dados (nunca 0 inventado, GER-22)
      "esperado_kwh": 3.77,            // null quando não há esperado
      "sem_dados": false,              // true = barra ausente com "sem dados" (só passado/hoje)
      "futuro": false,                 // true = depois de agora: não desenhar nada nem "sem dados"
      "fonte": "ton",                  // Dia: "ton" | "nuvem" (curva da nuvem). Demais: ton|nuvem|manual|mista|null
      "kwh_ton": 6100.2, "kwh_nuvem": 6080.0,  // só Semana/Mês/Ano/Total: kWh de cada fonte no ponto
      "divergem": false                // só Semana/Mês/Ano/Total: algum dia do ponto divergiu
    }
  ],
  "resumo": {
    "energia_kwh": 8315.2,             // kWh da fonte escolhida (soma dos dias)
    "kwh_kwp": 5.5,                    // energia_kwh / kwp_dc (null se kwp_dc ausente)
    "esperado_kwh": 9100.0,            // null sem fonte
    "pct_esperado": 91.4,              // 0–100+ (pode passar de 100); null sem fonte
    "valor_rs": null,                  // só com exibir_rs; sempre rotular "estimado"
    "dias_com_dados": 1, "dias_no_periodo": 1
  },
  "perdas": {                          // null quando fonte = nenhuma (GER-6)
    "esperado_kwh": 9100.0, "real_kwh": 8315.2,
    "categorias": [
      { "chave": "indisponibilidade", "rotulo": "Indisponibilidade", "kwh": 120.0, "pct": 1.3, "valor_rs": null, "informativo": false },
      { "chave": "limitacao_projeto", "rotulo": "Limitação de projeto", "kwh": 400.0, "pct": 4.4, "valor_rs": null, "informativo": true },
      { "chave": "limitacao_externa", "rotulo": "Limitação externa", "kwh": 0, "pct": 0, "valor_rs": null, "informativo": false },
      { "chave": "outras", "rotulo": "Outras perdas", "kwh": 264.8, "pct": 2.9, "valor_rs": null, "informativo": false }
    ]
  },
  "fechamento": {                      // sempre o MÊS CORRENTE (independe do período escolhido)
    "mes": "2026-10",
    "disponivel": true,                // false antes do dia 5 sem histórico do mesmo mês (GER-28)
    "motivo": null,                    // "Disponível a partir do dia 5" quando disponivel=false
    "acumulado_kwh": 120000.0,         // dias completos do mês (até ontem), kWh da fonte escolhida
    "estimativa_kwh": 190000.0,
    "faixa_kwh": 8000.0,               // ± (GER-29)
    "valor_rs": null,
    "dias_decorridos": 19, "dias_do_mes": 31,
    "usa_historico": false             // true = misturou a média do mesmo mês de anos anteriores
  },
  "previsao_amanha": {                 // null quando fonte = nenhuma (GER-31); pode vir null até o job das 18h rodar
    "data": "2026-10-21", "energia_kwh": 6100.0, "valor_rs": null, "fonte": "satelite"
  }
}
```

Regras de exibição:
- `config.fonte = "nenhuma"` → `perdas`, `previsao_amanha`, `esperado_*` vêm `null`: não desenhar
  linha/marcador de esperado nem os cards de perdas e previsão.
- Rótulo do esperado: "esperado (satélite)" ou "esperado (solarímetro)" (GER-11).
- R$ só quando `config.exibir_rs = true` e sempre com "estimado".
- Dia = área de potência (`real_kw`) + linha tracejada (`esperado_kw`). Semana/Mês = barras por dia;
  Ano = barras por mês; esperado = marcador horizontal sobre cada barra (GER-21). Tocar numa barra
  abre aquele dia (semana/mês) ou mês (ano) — usar `pontos[i].data`.
- `sem_dados = true` → sem barra, mostrar "sem dados" (nunca zero).
- `real_kwh` (Semana/Mês/Ano/Total), `resumo.energia_kwh` e `fechamento` usam o kWh da fonte
  escolhida; `perdas`, `pct_esperado` e `esperado_*` continuam pelos intervalos da TON (a nuvem não
  tem os estados dos inversores para classificar perda).
- Selo da fonte perto do total: cinza; âmbar quando `fonte_geracao.divergem`. Toque/tooltip do dia:
  `kwh_ton` × `kwh_nuvem`.

### `GET /geracao-analise/unidades/:unidadeId/config`

```jsonc
{
  "unidade_id": "...", "pode_editar": true,     // super_admin, admin, analista
  "config": {
    "fonte": "nenhuma", "solarimetro_equipamento_id": null, "solarimetro_medicao": null,
    "kwp_dc": 1512, "potencia_ac_kw": null, "inclinacao_graus": 16, "azimute_graus": 0,
    "fator_desempenho": 0.8, "exibir_rs": false, "tarifa_concessionaria_id": null,
    "fonte_geracao": "automatico",               // automatico | ton | nuvem
    "atualizado_em": null, "atualizado_por": null
  },
  "pode_fixar_fonte": false,                     // true só para papel canônico admin (super_admin/admin)
  "sugestoes": { "kwp_dc": 1512, "potencia_ac_kw": 999, "inclinacao_graus": 16, "azimute_graus": 0 },
  "faixas": { "kwp_dc": [1, 100000], "potencia_ac_kw": [1, 100000], "inclinacao_graus": [0, 90],
              "azimute_graus": [0, 359], "fator_desempenho": [0.5, 1.0] },
  "solarimetros": [{ "id": "...", "nome": "..." }],
  "inversores": [{ "id": "...", "nome": "Inversor 1", "potencia_kw": 333 }],
  "concessionarias": [{ "id": "...", "nome": "Equatorial GO" }],
  "tarifa_preview_rs_kwh": 0.95                  // tarifa com impostos que seria usada
}
```

### `PUT /geracao-analise/unidades/:unidadeId/config` (super_admin, admin, analista)

Corpo: os campos de `config` (sem `atualizado_*`). Valor fora da faixa → 400 com a mensagem.
`kwp_dc` obrigatório. `potencia_ac_kw = null` = soma dos inversores. Fonte `solarimetro` exige
`solarimetro_equipamento_id` (equipamento da instalação) e `solarimetro_medicao` (`GHI`|`POA`).
`fonte_geracao` ausente = mantém a gravada; mudar `fonte_geracao` sem ser admin → 403
"Só admin pode fixar a fonte da geração" (o resto da config segue editável pelos analistas); antes do
SQL 2026-10-21 aplicado, mudar a fonte → 400.
Grava histórico (`unidade_usina_config_historico`, campo a campo antigo → novo), evento no
Registro da instalação (`logs_mqtt`, `comando_semantico = 'usina.config'`) e audit log
(`auditoria_acessos`, `acao = 'usina_config'`, `objeto_tipo = 'unidade'`, `objeto_id` = unidade,
`unidade_ids`; `detalhes`: `usuario` {id, nome, papel}, `unidade` {id, nome}, `campos_alterados`,
`alteracoes` [{campo, rotulo, de, para}], ip, user_agent). Buscar por campo:
`detalhes->'campos_alterados' ? 'fonte_geracao'`. Mudar a fonte limpa o cache da análise e o cache em
memória do `FonteGeracaoService`. Responde como o GET.

## Cálculo (resumo)

- Intervalo base 15 min, fuso America/Sao_Paulo. `P_real` = média da potência ativa de cada inversor
  no intervalo (lacuna ≤ 30 min repete o último valor), somada.
- `P_esperada = kWp_DC × G_poa/1000 × fator_desempenho`, sem limite AC (GER-13/14).
- Irradiância: `IrradianceProvider` (Open-Meteo hoje). Satélite: `satellite-api.open-meteo.com/v1/archive`
  (`global_tilted_irradiance`, `temporal_resolution=native`, 15 min na América do Sul, ~2 h de atraso).
  Previsão: `api.open-meteo.com/v1/forecast` (`minutely_15`). Com `OPEN_METEO_API_KEY` usa os hosts
  `customer-*` (plano comercial). Azimute da spec (0 = norte) vira o do Open-Meteo (0 = sul).
- Solarímetro: lê a irradiância do equipamento vinculado; GHI vira POA por Erbs + modelo isotrópico.
- Perdas por intervalo, nesta ordem: indisponibilidade (inversor em falha/desligado/sem comunicação/
  sem rede, proporcional à potência do inversor) → limitação de projeto (`P_real ≥ 0,98 × P_AC`) →
  limitação externa (registro de limite < 100% ou `P_real` estável < 2% por 15 min abaixo de
  0,98 × P_AC com `P_esp > 1,10 × P_real`) → outras = resto (≥ 0).
- Jobs: a cada hora (irradiância das últimas horas + dia de hoje), 06:00 (refaz ontem consolidado e
  registra "Limitação externa" no Registro), 18:00 (previsão de amanhã).
- Resumo diário em cache (`geracao_analise_diaria`); mudar a config limpa o cache da instalação.

## Fonte da geração (NEXON-37)

`FonteGeracaoService` (`fonte-geracao.service.ts`; regra pura em `geracao-fonte.ts`, testada em
`geracao-fonte.spec.ts`) decide, por unidade e por dia BRT, de onde vem o kWh. Usado pela análise,
pelo COA (`energiaHoje`/`energiaOntem`, `fonteGeracao`, `fontesDivergem`) e pelos boletins diário
(WhatsApp) e semanal (PDF) — o mesmo número em todo lugar.

Entradas do dia:
- `kwh_ton` = Σ por inversor (lista de `GeracaoConfigService.inversores()`) de `MAX(daily_yield)` do
  dia, **sem** as linhas `equipamentos_dados.fonte = 'NUVEM_FUSION'` (fallback de nuvem do Fusion) e
  sem `qualidade = 'MOCK'`. `daily_yield` só conta a partir das 04:00 (inversor que zera tarde manda
  o total de ontem de madrugada) e só entre 0 e 20 000 kWh (teto anti-glitch). Inversor sem
  `daily_yield` usa a integral da potência. null = nenhum inversor com leitura.
- `ton_completa` = todo inversor com leitura em ≥ 70% dos blocos de 15 min de 06:00–18:00 (hoje: até
  agora). Inversor sem leitura = incompleta.
- `kwh_nuvem` = `MAX(kwh_acumulado)` do dia em `geracao_horaria_plantas` (06h em diante — a madrugada
  traz o total de ontem; origem ≠ manual); sem horário, `geracao_diaria_plantas.kwh_realizado` com
  origem nuvem/api; sem os dois, hoje/ontem, o fallback Fusion (`NUVEM_FUSION`, Σ `daily_yield`).
- `nuvem_completa` = dia passado com diário ou horário até ≥ 17h; hoje: snapshot nas últimas 2 h (ou
  o diário das 21h).
- `kwh_manual` = `geracao_diaria_plantas` com origem manual/bdo.

Escolha (`fonte`, `motivo`), nesta ordem: manual (`manual`, vence até fonte fixada) → fonte fixada
(`fixada`; sem dado nela e com dado na outra, a outra com `fixada_sem_dado`) → só uma com dado
(`so_ton`/`so_nuvem`; nenhuma: `null`, `sem_dados`) → nuvem = 0 e TON > 0 (`ton`, `nuvem_zerada`) →
divergência `|ton − nuvem| / max ≤ 5%` (`ton`, `concordam`) → TON incompleta e nuvem completa
(`nuvem`, `ton_incompleta`) → senão `ton`, `divergem`.

Cache: `geracao_analise_diaria` guarda só a TON do dia (`kwh_ton`, `ton_completa`); a nuvem é lida a
cada pedido e a escolha refeita (a nuvem chega às 21h, a escolha nunca fica congelada). Sem o SQL
2026-10-21, a TON do cache sai da integral da potência e o dia é refeito quando o SQL entra.
O `porDias` (COA, boletins) lê em lote: inversores, config, TON (agregada por inversor e dia no SQL),
horário, diário e fallback Fusion — 6 consultas por chamada, cache de 60 s.

No Dia com fonte nuvem, os 96 pontos saem do horário da nuvem: o snapshot das H h traz o kWh desde o
anterior e vira `real_kw = kwh_hora` nos 4 blocos da hora que terminou (H−1 h); sem horário (Fusion),
a potência do fallback `NUVEM_FUSION`; sem nenhum, fica a curva da TON (`fonte: "ton"`).

COA (`GET /coa/dashboard`, por unidade): `fonteGeracao` (ton|nuvem|manual|null) e `fontesDivergem`
de hoje. Em `energiaHoje`/`energiaOntem` a parcela dos inversores (já com as perdas da config de
demanda) sai e entra o kWh escolhido × o mesmo fator de perdas; consumo e o resto seguem iguais.
`fonteDados` (layout do web) não mudou. Operador só com "Ver geração" na instalação.

Boletim diário: o kWh da linha é o escolhido; a confiança continua dizendo se TON e API batem e se a
TON veio completa (`boletim-linha.ts`). Boletim semanal: semana, semana anterior, mês, ano e série
diária pelo kWh escolhido (previsto segue do diário).
