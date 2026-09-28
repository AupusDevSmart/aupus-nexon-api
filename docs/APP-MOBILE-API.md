# API dos apps NexON (iOS/Android) — contratos v2 (AUPU-70)

Rotas novas ou alteradas para os apps `AupusNexonApp` / `AupusNexonAppAndroid`. O contrato
de referência dos apps é a seção "Contratos novos da API [v2-API]" do SPEC-V2; este arquivo
diz o que o servidor faz de fato.

Base: `/api/v1`. Respostas no envelope `{ success, data, meta }` (ResponseInterceptor).
Erros: `{ success: false, error: { code, message, details } }`; `code` é o código de domínio
quando existe (ex.: `COMANDO_FORA_JANELA`), senão sai do status HTTP.

## Headers que os apps mandam em toda request

| Header | Exemplo | Onde é gravado |
|---|---|---|
| `X-Client-Platform` | `iOS` / `Android` | `auth_sessoes.plataforma`, rótulo do dispositivo |
| `X-Client-Device` | `iPhone 15 Pro` | `logs_mqtt.dispositivo` ("iPhone 15 Pro · iOS"), `auth_sessoes.dispositivo`, `auditoria_acessos.dispositivo` |

Sem os headers (web), o rótulo vem do User-Agent ("Chrome no Windows"). CORS libera os dois.

## Trilha: alarmes, comandos e acessos

### `GET /logs-mqtt`
Resposta dupla de sempre: `data: { data: [...], pagination: { page, limit, total, totalPages } }`.

Query nova (além de `page`, `limit` ≤ 100, `search`, `equipamentoId`, `unidadeId`, `regraId`,
`severidade`, `dataInicial`, `dataFinal`, `orderBy`, `orderDirection`):

| Parâmetro | Valores | Efeito |
|---|---|---|
| `tipo` | csv de `alerta`, `comando`, `acesso` | Ausente = todos os de `logs_mqtt` (sem `acesso`, como antes). `acesso` vem de `auditoria_acessos` |
| `status` | `ativo` · `reconhecido` · `resolvido` | Implica `tipo=alerta`. `ativo` = sem reconhecer, sem resolver, **não silenciado agora** e dos últimos `ALARME_ATIVO_JANELA_DIAS` (env, padrão 7; 0 = sem limite) |
| `plantaId` | id | Planta do equipamento (acesso: plantas afetadas) |
| `usuarioId` | id | Autor do comando (acesso: autor da mudança) — "Registro de atividade" |

Campos novos em cada linha: `usuario {id, nome} | null`, `dispositivo`, `reconhecido_em`,
`reconhecido_por {id, nome} | null` (id null em reconhecimentos antigos, que só guardavam o nome),
`resolvido_em`, `resolvido_por {id, nome} | null`, `silenciado_ate`,
`equipamento {id, nome, unidade {id, nome, cidade} | null} | null`, `regra`.
Linhas `tipo = 'acesso'` trazem também `alvo_usuario {id, nome}` e `detalhes` (antes/depois),
com `equipamento = null` e `severidade = 'INFO'`.

Escopo: operador/proprietário só veem as plantas deles. Linhas de acesso: operador vê só as
que mudaram o acesso dele (ou que ele fez); proprietário, as das plantas dele.

Sem o SQL da trilha aplicado, a rota cai na listagem antiga (sem os campos novos, sem `acesso`).

### `POST /logs-mqtt/:id/resolver`
Marca `resolvido_em`/`resolvido_por` (idempotente). Só `tipo = 'alerta'` (400 nos outros).
Resposta `{ ok, resolvido_em }`.

### `POST /logs-mqtt/:id/silenciar` `{ horas: 1..24 }`
`silenciado_ate = agora + horas`; sai de "ativo" até vencer. Resposta `{ ok, silenciado_ate }`.

### `POST /logs-mqtt/:id/reconhecer` (existente)
Passa a gravar também `reconhecido_por_id`.

### Trilha de comando (o que o servidor grava)
`POST /equipamentos/:id/pontos/:pontoId/acionar` e `POST /equipamentos/:id/cmd` gravam em
`logs_mqtt` (`tipo = 'comando'`) com `usuario_id`, `dispositivo`, `status`, `latency_ms`,
`comando_semantico` ("Pivô 3 · Ligar pivô"):

| `status` | Quando | `severidade` |
|---|---|---|
| `ok` / `duplicate` | TON confirmou | INFO / WARN |
| `timeout` | TON não respondeu (504) | ERROR |
| `error` | TON/relé recusou (502) | ERROR |
| `bloqueado` | Barrado pelas regras abaixo (403); `mensagem` = motivo | WARN |

O `/cmd` não gravava nada antes; agora grava. `/cmd/wifi` continua sem trilha.

### Bloqueios do acionar (403)
Avaliados nesta ordem, só fora do modo bancada (`sim: true` não passa por eles):

| `error.code` | Regra |
|---|---|
| `SEM_PERMISSAO_UNIDADE` | Usuário com linhas em `usuario_unidade_permissoes` e sem `comandar` na unidade do equipamento (ou do equipamento pai). Usuário sem nenhuma linha = modelo antigo, vale só a permission do papel |
| `COMANDO_FORA_JANELA` | `usuarios.cmd_janela` definida e o horário de America/Sao_Paulo fora dela (janela que atravessa a meia-noite pertence ao dia em que começa) |
| `COMANDO_BLOQUEADO_PONTA` | `pivo_config.bloqueio_ponta.ativo` e agora dentro da janela, **só para ponto de partida** (nome com ligar/liga/partida/start; desligar/parar nunca é barrado) |

## `GET /iot/disjuntor/:id/scs-bundle`
Novo `status_pontos: [{ ponto_id, nome, papel, valor, updated_at }]` (resposta dupla como hoje).
Fonte: `iot_vinculos` com `fonte_tipo = 'ton_bi'` dos pontos do DJ; `valor` = bit `d{canal}` do
último `equipamento_io_estado` da TON (o mesmo de `GET /equipamentos/:tonId/bis/estado`), com
inversão NF (`params.invertido`); `null` sem leitura. `papel` = `iot_vinculos.papel` quando é
`aberto|fechado|mola|local|remoto`, senão inferido pelo nome ("Mola carregada" → `mola`; nome
ambíguo como "Local/Remoto" → `null`). Espelho de vínculos vazio → cai em `ton_bi`. Erro → `[]`.

## `GET /coa/dashboard`
- `resumoGeral.alarmesLogsAtivos`, `resumoGeral.alarmesDesde` (ISO do mais antigo | null): mesma
  regra de "ativo" do `/logs-mqtt`, nas unidades do dashboard. Omitidos se o SQL da trilha não rodou.
- `unidades[].metricas.energiaOntem`: D-1 em America/Sao_Paulo, mesmo método do `energiaHoje`
  (configuração de demanda com sinal/perdas; fallback legado somando tudo). Unidade que hoje vem
  da nuvem (ou sem telemetria ontem) usa `geracao_diaria_plantas.kwh_realizado` de ontem.
  Cache de 10 min.
- `unidades[].equipamentosScs`: equipamentos da unidade no arqIoT = componente do diagrama IoT
  (menos a própria TON) ou ponto com vínculo ativo. `0` = "Sem instrumentação". Omitido em erro.
- Corrigido: o sinóptico (`/sinoptico/...`) contava comando como alarme.

## Conta

| Rota | Corpo / resposta | Observação |
|---|---|---|
| `GET /auth/me` | + `senha_alterada_em` | Carimbado em troca de senha, reset admin e redefinição por token/convite |
| `PATCH /usuarios/me` | `{ nome?, telefone?, email? }` → usuário + `senha_alterada_em` | Sempre o dono do token. Email único (409) |
| `GET /usuarios/me/notificacoes` | `{ alarmes_criticos, alarmes_atencao, comandos, resumo_diario }` | Padrão: críticos e atenção ligados |
| `PUT /usuarios/me/notificacoes` | parcial, devolve o estado final | |
| `POST /usuarios/me/dispositivos` | `{ plataforma: ios\|android\|web, token }` | Upsert pelo token. **Envio de push ainda não existe** (sem APNs/FCM); só guarda |
| `DELETE /usuarios/me/dispositivos/:token` | `{ ok, removidos }` | |
| `PATCH /usuarios/:id/change-password` | igual | **Só o próprio id**, ou quem tem `usuarios.manage` (403). Encerra as outras sessões |
| `PATCH /usuarios/:id/reset-password` | igual | Agora exige `usuarios.manage` + escopo: proprietário só quem criou; admin só por super_admin. Encerra todas as sessões do alvo |

### Sessões
| Rota | Resposta |
|---|---|
| `GET /auth/sessions` | `[{ id, dispositivo, plataforma, cidade, ip, created_at, last_used_at, atual }]` (404 sem o SQL) |
| `DELETE /auth/sessions/:id` | `{ ok }` (404 se não for do usuário) |
| `DELETE /auth/sessions?outras=true` | `{ encerradas }` — menos a deste token |

Login cria sessão; access e refresh token levam `sid`, o refresh leva também `jti`. Cada refresh
rotaciona o `jti` (o anterior vale 60 s, para refresh concorrente). Sessão encerrada → refresh 401;
o access token já emitido vale até expirar (1 h). Tokens antigos, sem `sid`, continuam válidos e
ganham sessão no primeiro refresh. `cidade` fica `null` (sem geo-IP).

## Operadores

| Rota | Permissão | Resposta |
|---|---|---|
| `GET /usuarios/operadores` | `usuarios.view` | `[{ id, nome, email, telefone, status, is_active, plantas_count, unidades_count, permissoes {visualizar, comandar, relatorios}, convite {id, enviado_em, expira_em} \| null, desativado_em, created_at }]` |
| `POST /usuarios/convites` | `usuarios.create_operador` ou `usuarios.manage` | `{ usuario {id}, convite {id, expira_em, link} }` |
| `POST /usuarios/convites/:id/reenviar` | idem | mesmo formato, token e validade novos |
| `GET /usuarios/:id/acesso` | `usuarios.view` (operador: só o próprio) | `{ unidade_ids, permissoes, excecoes, janela, origem }` |
| `PUT /usuarios/:id/acesso` | `usuarios.create_operador` ou `usuarios.manage` | idem; grava "Permissões alteradas" na trilha (`tipo=acesso`) |

Corpo do convite: `{ nome, email, telefone?, canais: ['email','whatsapp'], validade_dias, unidade_ids,
permissoes {comandar, relatorios}, excecoes [{unidade_id, comandar, relatorios}], janela {inicio, fim, dias} | null }`.

- O convite cria o operador `status = 'Inativo'` com senha aleatória; o `link` é o fluxo de
  redefinição que já existe (`/redefinir-senha?token=&email=`). Redefinir com o token do convite
  ativa o usuário e marca `aceito_em`. WhatsApp: o app abre `wa.me` com o link.
- Email pelo mailer existente; **sem SMTP o convite não falha** (só loga).
- Proprietário: lista e gere só os operadores que criou, só em plantas dele. Hoje o papel
  proprietário não tem `usuarios.create_operador` (tirado em 2026-09-10), então não convida.
- `usuario_unidade_permissoes`: visualizar é a linha existir. Salvar o acesso também sincroniza
  `planta_operadores` (plantas das unidades escolhidas) e `usuarios.cmd_janela`.

## Pivôs

| Rota | Permissão | Corpo / resposta |
|---|---|---|
| `GET /pivos/unidade/:unidadeId/conjugados` | escopo | `[{ motobomba {equipamento_id, nome}, pivos [{equipamento_id, nome}] }]` — só motobomba com 2+ pivôs |
| `GET /pivos/:id/config` | escopo | `{ equipamento_id, bloqueio_ponta {ativo, inicio, fim, dias}, reservado {…}, origem_ponta {numero_uc, concessionaria} \| null, motobomba_equipamento_id, updated_at }` |
| `PUT /pivos/:id/config` | `equipamentos.acionar_ponto` ou `equipamentos.manage` (+ comandar na unidade) | parcial: `bloqueio_ponta?`, `reservado?`, `motobomba_equipamento_id?` (null desfaz) |
| `GET /pivos/:id/programacoes` | escopo | `[{ id, nome, ativo, hora_inicio, dias, modo, angulo_inicial, angulo_final, duracao_min, sentido, velocidade, com_agua, created_at, updated_at }]` |
| `POST /pivos/:id/programacoes` | como o PUT de config | cria; `duracao_min` obrigatório no modo `tempo` |
| `PUT /pivos/:id/programacoes/:progId` | idem | atualiza (corpo completo) |
| `DELETE /pivos/:id/programacoes/:progId` | idem | exclusão lógica |

- Sem config gravada: ponta 18:00–21:00 seg–sex e reservado 21:30–06:00 todos os dias, os dois
  **desligados** (o bloqueio só vale depois que alguém liga e salva — nada muda no deploy).
- `origem_ponta` vem da unidade do pivô (`numero_uc` + nome da concessionária).
- **Programações são só armazenadas.** O servidor não tem agendador de comando e não liga pivô
  sozinho; quem executa é o operador ou o CLP.
- A motobomba do sistema conjugado é definida pelo `PUT /pivos/:id/config` de cada pivô
  (tem de ser da mesma instalação).
- Sem o SQL: leituras devolvem padrão/vazio; escritas 404.

## SQL para aplicar em produção (nesta ordem, antes do deploy)

Todos idempotentes (`IF NOT EXISTS`), só aditivos, com ROLLBACK no cabeçalho de cada arquivo.

1. `db/manual-migrations/2026-09-28_1-logs-mqtt-trilha.sql` — colunas de trilha em `logs_mqtt`, índices, `auditoria_acessos`
2. `db/manual-migrations/2026-09-28_2-usuarios-conta.sql` — `usuarios.senha_alterada_em`, `usuarios.cmd_janela`, `usuario_notificacoes`, `dispositivos_push`
3. `db/manual-migrations/2026-09-28_3-auth-sessoes.sql` — `auth_sessoes`
4. `db/manual-migrations/2026-09-28_4-operadores-convites.sql` — `usuario_convites`, `usuario_unidade_permissoes`
5. `db/manual-migrations/2026-09-28_5-pivos.sql` — `pivo_config`, `pivo_programacoes`

```bash
for f in db/manual-migrations/2026-09-28_{1,2,3,4,5}-*.sql; do psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"; done
```

As tabelas e colunas novas ficam fora do `schema.prisma` (acesso por SQL), como as outras de
`prisma/TABELAS-FORA-DO-SCHEMA.md` — `prisma migrate diff` proporia dropá-las.
