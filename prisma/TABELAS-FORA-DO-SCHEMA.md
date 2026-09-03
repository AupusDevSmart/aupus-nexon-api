# Tabelas que existem no banco e NAO estao neste schema

**Levantado em 2026-08-26, contra producao.**

Este banco e compartilhado. Alem dos modelos declarados em `schema.prisma`, ele
tem tabelas criadas por SQL manual — algumas de outro sistema, outras deste
monorepo mas nunca modeladas.

> **`prisma migrate diff` proporia DROPAR todas as listadas abaixo.**
> Nunca aplique um diff sem ler linha a linha e remover os DROP.

## As tabelas

| Tabela | Origem | Onde esta o DDL |
|---|---|---|
| `equipamento_io_estado` | AupusNexOn — IO da TON | `aupus-nexon-api/db/manual-migrations/2026-06-18_bi_inputs.sql` |
| `ton_bi` | AupusNexOn — entrada digital | idem |
| `ton_ai` | AupusNexOn — entrada analogica | `.../2026-08-20_ai_inputs.sql` |
| `moradores` | AupusNexOn — carregador eletrico | `.../2026-08-20_carregador_eletrico.sql` |
| `carregador_config` | idem | idem |
| `carregador_sessoes` | idem | idem |
| `carregador_pedidos_vaga` | idem | idem |
| `iot_comissionamento` | AupusNexOn — comissionamento (2026-08) | `.../2026-08-25_comissionamento.sql` e `2026-08-26_comissionamento_fotos.sql` |
| `iot_*` (7 tabelas) | `/var/www/iot_nexon/` — outro sistema | fora deste monorepo |

Total: **15 tabelas** que o diff nao reconhece.

### Cuidado com o prefixo `iot_`

`iot_comissionamento` **nao** e do `/var/www/iot_nexon/`. E deste monorepo, do
AupusNexOn, e so compartilha o prefixo. Tratar todo `iot_*` como "sistema dos
outros" leva a conclusao errada nos dois sentidos: ignorar uma tabela que e nossa
e deveria estar modelada, ou adotar as que nao sao.

Confirmado em producao em 2026-08-26 (so SELECT): a tabela existe, com o indice
unico `uq_iot_comissionamento_equip` e a coluna `fotos` (jsonb) do segundo
arquivo. 12 colunas, 0 linhas. Nada pendente de aplicar — os dois SQL ja rodaram.

Ainda **nao esta modelada aqui**, e nao da para modelar de memoria: o DDL vive num
arquivo nao commitado no servidor, e ler a lista de colunas nao garante tipo,
tamanho nem nulidade. Modelar quando o NexOn tiver a janela dele, pelo caminho de
introspeccao descrito no fim deste documento.

## A inconsistencia do ton_bo

`ton_bo` **esta** no schema; `ton_bi` e `ton_ai` **nao**. Os tres sao a mesma
familia — saida digital, entrada digital e entrada analogica da TON — e foram
criados pelo mesmo caminho.

Nao ha razao tecnica para a diferenca; e acidente. Enquanto durar, o diff trata
irmaos de formas opostas: preserva um e propoe dropar os outros dois.

## Por que nao estao modeladas

O SQL foi escrito a mao, direto no servidor, e o codigo as acessa por
`$queryRaw` / `$executeRaw` — nunca pelo client tipado. O cabecalho de
`2026-08-20_ai_inputs.sql` explica a escolha da epoca: o `schema.prisma` vive num
pacote git hardlinkado ao store do pnpm, e o CLI do Prisma nao esta instalado
naquele servico.

O comentario daquele arquivo diz que `prisma migrate deploy` nunca dropa tabela
fora do schema, e conclui que e seguro. **E verdade sobre o `migrate deploy` —
mas ninguem aqui roda `migrate deploy`.** O fluxo deste monorepo e
`migrate diff` + apply seletivo, e e esse que enxerga tabela orfa como coisa a
remover. A garantia do comentario e sobre um comando que nao esta no caminho.

## DEV e PROD divergem

**Nenhuma destas tabelas existe em dev**, exceto `ton_bo` e as `iot_*`. Elas
nasceram direto em producao.

Consequencias praticas:

1. Rodar `migrate diff` contra **dev** nao acusa nada — o diff sai limpo e da
   falsa seguranca. O estrago so aparece se o mesmo diff for rodado contra prod.
2. As rotas do TON AI e do carregador **nao funcionam em dev**: o codigo faz
   `$queryRaw` numa tabela que nao existe ali.

Para realinhar o dev, aplicar os tres arquivos de
`aupus-nexon-api/db/manual-migrations/` — sao todos `IF NOT EXISTS` e aditivos.

## A correcao de raiz

Modelar as sete tabelas deste monorepo aqui no `schema.prisma`. As `iot_*` ja
foram modeladas por esse motivo e pararam de aparecer no diff — o precedente
existe e funcionou.

O caminho: aplicar os SQL em dev, `prisma db pull` para uma copia descartavel do
schema, e trazer os modelos introspectados para ca. Introspectar da o tipo exato
de cada coluna, o que ler o DDL a mao nao garante.

As `iot_*` continuam sendo caso a parte: sao de outro sistema, e modelar aqui foi
defesa contra o DROP, nao adocao.
