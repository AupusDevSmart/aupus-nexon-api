# Análise de geração (NEXON-16)

Spec: card NEXON-16 ("Spec NexON — Análise de geração"). Vale para web e apps.
Módulo: `src/modules/geracao-analise/`. SQL: `db/manual-migrations/2026-10-20_geracao_analise.sql`.

A análise olha **só os inversores** da instalação (GER-2). Carga, medidor e líquido continuam
vindo dos endpoints de sempre.

## Endpoints (prefixo `/api/v1`, JWT; resposta no envelope `{success, data}` de sempre)

### `GET /geracao-analise/unidades/:unidadeId?periodo=dia|semana|mes|ano&data=YYYY-MM-DD`

Qualquer usuário com acesso à instalação. `data` = qualquer dia dentro do período (padrão: hoje,
fuso America/Sao_Paulo). Semana = segunda a domingo.

```jsonc
{
  "unidade_id": "cmh...", "unidade_nome": "UFV SOLAR POWER",
  "periodo": "dia",                    // dia | semana | mes | ano
  "referencia": "2026-10-20",          // a data pedida (normalizada)
  "inicio": "2026-10-20", "fim": "2026-10-20",   // primeiro e último dia do período
  "anterior": "2026-10-19", "proximo": null,     // data para < e > (null = futuro, não navega)
  "hoje": "2026-10-20",
  "config": {
    "fonte": "satelite",               // satelite | solarimetro | nenhuma
    "kwp_dc": 1512, "potencia_ac_kw": 999,
    "exibir_rs": false, "tarifa_rs_kwh": null   // tarifa só vem quando exibir_rs = true
  },
  "tem_inversor": true,                // false = instalação sem geração (não mostrar a análise)
  "tem_dados": true,                   // false = inversores nunca mandaram leitura → pontos vazio e
                                       //   resumo/perdas/fechamento/previsao null (mostrar o gráfico antigo)
  "agora": {                           // só em periodo=dia e data=hoje
    "potencia_kw": 0.0,                // soma dos inversores na última leitura (≤ 15 min)
    "gerando": false                   // false depois do pôr do sol → destacar o resumo do dia (GER-24)
  },
  // Dia: 96 pontos de 15 min. Semana/Mês: 1 por dia. Ano: 1 por mês.
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
      "futuro": false                  // true = depois de agora: não desenhar nada nem "sem dados"
    }
  ],
  "resumo": {
    "energia_kwh": 8315.2,
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
    "acumulado_kwh": 120000.0,         // dias completos do mês (até ontem)
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

### `GET /geracao-analise/unidades/:unidadeId/config`

```jsonc
{
  "unidade_id": "...", "pode_editar": true,     // super_admin, admin, analista
  "config": {
    "fonte": "nenhuma", "solarimetro_equipamento_id": null, "solarimetro_medicao": null,
    "kwp_dc": 1512, "potencia_ac_kw": null, "inclinacao_graus": 16, "azimute_graus": 0,
    "fator_desempenho": 0.8, "exibir_rs": false, "tarifa_concessionaria_id": null,
    "atualizado_em": null, "atualizado_por": null
  },
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
Grava histórico (`unidade_usina_config_historico`, campo a campo antigo → novo) e evento no
Registro da instalação (`logs_mqtt`, `comando_semantico = 'usina.config'`). Responde como o GET.

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
