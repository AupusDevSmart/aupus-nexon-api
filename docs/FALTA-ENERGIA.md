# Falta de energia → protocolo na concessionária (NEXON-145)

A TON avisa que a rede caiu; o NexON abre um chamado **externo** (NEXON-144) e manda para o robô
da Equatorial no WhatsAupus, que conversa com a Clara (WhatsApp 62 3243-2020) e devolve o protocolo.

```
TON ──MQTT <base>/energia──▶ NexON API ──POST /api/v1/webhook/nexon/falta-energia──▶ WhatsAupus
                              │  (falta_energia_eventos)                            │ robô (Evolution) ↔ Clara
                              │◀──POST /api/v1/falta-energia/whatsaupus/<token>─────┘ protocolo
                              └─ chamado EXTERNO: protocolo, EM_ANDAMENTO, RESOLVIDO quando a energia volta
```

## Contrato da TON

Tópico `<topic_base>/energia`, QoS 1, **não retido** (retido é ignorado). Payload JSON:

| Campo | Valores |
| --- | --- |
| `evento` | `"falta"` ou `"retorno"` (aceita também `rede: 0/1` ou `estado: "sem_rede"/"normal"`) |
| `ts` | quando aconteceu: epoch em s ou ms, ou ISO. Relógio fora de ±2 dias é trocado pela hora do servidor |

Exemplo: `{"evento":"falta","ts":1764000000}`. A TON precisa estar alimentada (nobreak/bateria) para
conseguir avisar a falta; o `retorno` fecha o chamado.

## Regras

- **Confirmação**: só abre depois de `FALTA_ENERGIA_CONFIRMAR_MIN` minutos (padrão 3) sem `retorno`.
  Voltou antes = `CANCELADO`, nada aberto ("piscada").
- **Um por UC**: avisos da mesma unidade (ou da planta, sem unidade) nas últimas 24 h caem no mesmo
  evento (`avisos` conta quantos).
- **Dados enviados**: ponto de referência (planta + endereço, uma linha), UC (`unidades.numero_uc`, senão `plantas.numero_uc`), endereço da planta, nome,
  CPF/CNPJ e telefone do proprietário da planta.
- **Só Equatorial Goiás**: concessionária da unidade com "Equatorial" em GO, ou sem concessionária e
  UF GO. Fora disso, ou sem UC/proprietário/telefone: chamado aberto com status `SEM_DADOS` e nota
  dizendo o que falta; corrigido o cadastro, "Reenviar".
- **Entrega**: 5 tentativas (0, 1, 2, 4, 8 min). Depois `FALHOU` com nota para abrir na mão.
- **Robô travou**: o WhatsAupus passa para um atendente (`NEEDS_HUMAN`); quando ele registra o
  protocolo lá, o callback chega igual.
- **Retorno**: token aleatório na URL (só o hash fica no banco), um por aviso.
- **Desligar**: `FALTA_ENERGIA_ATIVO=false`.

## Status do evento

`AGUARDANDO` → `ENVIANDO` → `NO_ROBO` → `PROTOCOLO` · `CANCELADO` · `SEM_DADOS` · `FALHOU`

## Trilha

`auditoria_acessos` com `objeto_tipo = 'falta_energia'`, `objeto_id` = evento, ações
`falta_energia_aviso | _manual | _enviada | _protocolo | _falhou | _retorno`; mensagem sempre com
planta, UC e protocolo. A linha do tempo do chamado recebe uma nota a cada passo.

## API

- `GET /falta-energia?chamado_id=&planta_id=` — avisos no escopo do usuário.
- `POST /falta-energia/avisar {equipamento_id | unidade_id}` — admin e analistas, abre na hora.
- `POST /falta-energia/:id/reenviar` — depois de `FALHOU`/`SEM_DADOS`.
- `POST /falta-energia/whatsaupus/:token` — callback público do WhatsAupus.

SQL: `db/manual-migrations/2026-11-24b_falta_energia.sql` (depois do `2026-11-24_chamados_externos.sql`).
Credencial do WhatsAupus: a mesma do envio de notificações (`bdo.configuracoes.whatsapp_api_key`),
ou `WHATSAUPUS_URL`/`WHATSAUPUS_API_KEY`. Base do callback: `NEXON_API_PUBLIC_URL`
(padrão `https://aupus-nexon-api.aupusenergia.com.br/api/v1`).
