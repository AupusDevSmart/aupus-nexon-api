# Chamados (NEXON-24)

Quem opera pede reparo de um equipamento pela web ou pelo app. O NexON registra o chamado
(equipamento, descrição, autor) e **encaminha** — não gera ordem de serviço.

- Tabelas: `chamados`, `chamados_encaminhamentos` (`db/manual-migrations/2026-10-20c_chamados.sql`).
- Status do chamado: `ABERTO` → `ENCAMINHADO` → `FECHADO`. O número do menu é ABERTO + ENCAMINHADO.
- Escopo: `planta_id` do chamado contra o escopo do usuário (PermissionScopeService).

## Endpoints (`/api/v1/chamados`)

| Método | Rota | O quê |
| --- | --- | --- |
| GET | `/chamados?status=ABERTOS\|ABERTO\|ENCAMINHADO\|FECHADO&prioridade&planta_id&unidade_id&equipamento_id&busca&page&limit` | lista (`busca` aceita `#12`) |
| GET | `/chamados/contagem` | `{ abertos, aguardando_encaminhamento, encaminhados }` |
| GET | `/chamados/:id` | detalhe + encaminhamentos + `contatos_proprietario` |
| POST | `/chamados` | `{ equipamento_id, titulo, descricao, motivo?, prioridade?, canal? }` |
| POST | `/chamados/:id/encaminhar` | `{ destino: SMART_SERVICE\|WHATSAPP\|EMAIL, contato?, observacao? }` — sem contato usa o do proprietário |
| POST | `/chamados/:id/fechar` | `{ motivo }` |

## Auditoria

`auditoria_acessos`, ações `chamado_aberto`, `chamado_encaminhado`, `chamado_envio` (entregue ou falha
definitiva) e `chamado_fechado`. Mensagem sempre com `Chamado #N`, equipamento e planta; `detalhes` com
chamado, equipamento, unidade, planta, proprietário, destino/contato, ip e user agent.

```sql
SELECT created_at, acao, mensagem FROM auditoria_acessos
WHERE acao LIKE 'chamado_%' AND mensagem ILIKE '%Chamado #12 %' ORDER BY created_at;
```

## Fila de encaminhamento

`ChamadosEncaminhamentoWorker` roda a cada 15 s (`CHAMADOS_WORKER=off` desliga). Falha tenta de novo
com espera de 2 min por tentativa; na 5ª vira `FALHOU`.

- `EMAIL`: `MailService` (SMTP do NexON).
- `WHATSAPP`: `WhatsappService` (credencial em `bdo.configuracoes`).
- `SMART_SERVICE`: sem `SMART_SERVICE_URL` + `SMART_SERVICE_TOKEN` fica `AGUARDANDO_INTEGRACAO` e sai
  sozinho quando forem configuradas.

### Contrato esperado do Smart Service (ainda não existe do lado de lá)

```
POST {SMART_SERVICE_URL}/integracoes/nexon/chamados
Authorization: Bearer {SMART_SERVICE_TOKEN}
{
  "nexon_chamado_id": "…", "numero": 12, "titulo": "…", "descricao": "…",
  "motivo": "FALHA|ALARME|CAMPO|OUTRO", "prioridade": "BAIXA|MEDIA|ALTA|URGENTE",
  "equipamento_id": "…", "unidade_id": "…", "planta_id": "…", "proprietario_id": "…",
  "autor_nome": "…", "aberto_em": "ISO-8601", "observacao": "…"
}
→ 2xx { "id": "<id da solicitação no Service>" }   (aceita também { data: { id } })
```

Sugestão para o Service: criar a `solicitacoes_servico` com `origem = SISTEMA`,
`tipo = MANUTENCAO_CORRETIVA`, prioridade mapeada, ids já sincronizados (equipamentos/plantas/unidades
são os mesmos pela sincronização), e idempotência por `nexon_chamado_id`.
