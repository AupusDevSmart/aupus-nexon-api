# Bug: Power Meter modal soma 16k kWh quando medidor acumulou só 13,5k no período

## Contexto

- Equipamento CHINT (id `cmllgigy800cujqctbxnx1iq5`, fabricante Kron, tag MEDIDOR).
- Janela observada: 01/02/2026 → 22/05/2026.
- Modal Power meter → aba Relatório → campo `energia_total_kwh`.
- Endpoint: `GET /api/v1/equipamentos-dados/:id/custos-energia`.

## Causa raiz (resumida)

1. O `consumo_phf` no JSONB `equipamentos_dados.dados` chega **pronto do firmware do
   medidor** — o backend só persiste cru (`mqtt.service.ts:1246-1249`). Não há cálculo no
   backend nesse campo.
2. O firmware calcula `consumo_phf` em `mode: 'delta'` (ver
   `AupusNexOn/public/iot-device-catalog.v2.js:721`) = última amostra de `phf` menos
   primeira amostra da janela de ~30 s.
3. Em 10 leituras no período, o firmware enviou `consumo_phf ≈ phf` (ex.: 05/05 23:57,
   `phf=10557.6` e `consumo_phf=10381.6`). A "primeira amostra" da janela delta ficou
   presa num snapshot velho/zerado em NVM em vez de reler `phf`. **Causa raiz é firmware
   — fora do escopo deste ticket.**
4. `SUM(consumo_phf)` cru no período = 90.004 kWh. Com cap `<= 5 kWh` (que já é aplicado
   em `coa.service.ts:317` e `equipamentos-dados.service.ts:391,1088`) cai para 14.458,80
   kWh.
5. O endpoint `/custos-energia` adicionalmente compensa gaps > 10 min via delta-phf
   (`calculo-custos.service.ts:327-355`), somando +1.795,80 kWh no período. Total exibido
   na tela ≈ 16.254 kWh.
6. Delta-phf real do período (fonte da verdade do medidor) = `13.671,60 − 165,00 =
   13.506,60 kWh`.

## Estratégia da correção

**Não fazer backfill** das 10 leituras já gravadas — só corrigir daqui pra frente. As 10
leituras antigas continuam no banco com `consumo_phf` errado, mas:

- O relatório passa a usar `phf` (cumulativo do medidor) como fonte da verdade.
- A guarda na ingestão impede que mais leituras outlier sejam gravadas.

São **quatro mudanças** no `aupus-nexon-api`.

### (1) Guarda na ingestão MQTT

Arquivo: `src/shared/mqtt/mqtt.service.ts`, função `salvarDadosM160Resumo`.

Antes do `const dadosProcessados = { ...resumo }`, validar `resumo.consumo_phf`. Se for
`> 5` kWh (limite físico — > 5 kWh em 30 s equivale a > 600 kW, impossível para o
medidor), substituir pelo delta-phf real (`phf_atual − phf_anterior`) ANTES de salvar.

Cuidados:
- Manter `phf` cru intocado, só ajustar `consumo_phf`.
- Logar `warn` para observabilidade (contar outliers por equipamento = saúde de firmware).
- Não bloquear a gravação se a query falhar — em caso de erro, manter o comportamento
  atual (gravar como veio).

### (2) Trocar fonte da verdade na leitura para delta-phf

Arquivo: `src/modules/equipamentos-dados/services/calculo-custos.service.ts`.

Substituir `SUM(consumo_phf ≤ 5)` + compensação de gap por:

- `energia_total_kwh` do período = `phf(última leitura) − phf(primeira leitura)`.
- Se `phf` é nulo em alguma leitura, pular.
- Detectar reset (`phf_atual < phf_anterior`) e somar por segmento.

Distribuição por bucket de horário (PONTA/FORA_PONTA/RESERVADO/IRRIGANTE):

- Para cada bucket, `energia_bucket = Σ delta_phf positivo no bucket de timestamp[i]`.
- Equivalente a integrar `phf[i] − phf[i-1]` por bucket de horário de
  `timestamp_dados[i]`, ignorando deltas negativos (reset).

Remover constantes `MAX_CONSUMO_POR_LEITURA = 5` e `GAP_THRESHOLD_MS` — delta-phf cobre
gaps por natureza.

### (3) Paridade com `coa.service.ts`

Arquivo: `src/modules/coa/coa.service.ts:308-320`.

O painel COA também faz `SUM(consumo_phf <= 5)`. Aplicar mesma lógica de delta-phf no
SQL (`LAG()` em CTE) para não divergir do relatório do Power Meter.

### (4) Paridade nos gráficos de mês/ano

Arquivo: `src/modules/equipamentos-dados/equipamentos-dados.service.ts:391,1088`.

Os gráficos do modal Power Meter (aba "Gráfico Mês" e "Gráfico Ano") também somam
`consumo_phf <= 5` direto. Substituir por `LAG()` de phf na mesma CTE, com fallback
COALESCE pra inversores PV (`energy.period_energy_kwh`) e genéricos (`energia_kwh`)
intocados — só M-160 muda. Sem essa correção, o gráfico mostra X e o relatório mostra
Y pro mesmo período.

## Não tocar

- Schema do `equipamentos_dados`, `equipamentos`, `iot_*` (tabelas compartilhadas com
  `/var/www/iot_nexon/`).
- Firmware ou catálogo `iot-device-catalog.v2.js` (causa raiz original — ticket separado
  de firmware).
- Pipeline `mqtt-ingestion.service.ts` (usado por outros equipamentos).
- **As 10 linhas históricas com `consumo_phf` outlier ficam como estão.** Documentar
  como TODO de backfill futuro (ticket separado: backup → preview-rollback → COMMIT).

## Casos de teste

Rodar contra fixtures sintéticos. Resultados esperados:

| Cenário | Fonte | Esperado |
|---|---|---|
| Período sem outliers, sem gaps | delta-phf | == `phf_final − phf_inicial` |
| Período com outlier no meio | delta-phf | igual ao caso sem outlier (`consumo_phf` grande é ignorado) |
| Período com gap > 10 min | delta-phf | == delta no gap (sem dupla contagem) |
| Período cruzando reset de medidor (`phf` cai) | delta-phf por segmento | soma do segmento antes + segmento depois |
| Ingestão recebe `consumo_phf = 8000` com `phf=8100` (após `phf_prev=120` no banco) | guarda na ingestão | JSONB grava `consumo_phf = 7980` (corrigido) |
| Ingestão recebe `consumo_phf = 0.5` (normal) | guarda na ingestão | JSONB grava `consumo_phf = 0.5` (não toca) |
| Ingestão recebe `consumo_phf` válido mas banco vazio (primeira leitura) | guarda na ingestão | JSONB grava `consumo_phf` como veio |

## TODOs separados (NÃO fazer aqui)

- **Backfill histórico**: corrigir as 10 linhas em prod com `consumo_phf` outlier.
  Backup → preview-rollback → COMMIT em outro ticket.
- **Fix do firmware**: a regressão do snapshot delta em NVM. Ticket de firmware
  separado.
