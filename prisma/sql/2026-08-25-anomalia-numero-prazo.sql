-- Numero e prazo na anomalia.
--
-- Gerado por `prisma migrate diff` e editado a mao:
--   * removido o CREATE INDEX em iot_projetos — tabela do iot_nexon, fora desta
--     mudanca. Falso-positivo permanente do diff neste banco compartilhado.
--   * IF NOT EXISTS onde o Postgres aceita.
--
-- Totalmente aditivo: duas colunas novas e um indice. Nenhum DROP, nenhum ALTER
-- de coluna existente.
--
-- `numero` (ANO-0000, reinicia a cada ano) fica ANULAVEL de proposito: as
-- anomalias anteriores a este campo nao tem numero, e atribuir um agora
-- inventaria historico. No Postgres um indice UNIQUE aceita varios NULL, entao
-- a restricao vale so para quem tem numero de fato.
--
-- `prazo` e ate quando a anomalia precisa estar resolvida. E por ele que a lista
-- de origem da OS ordena e sinaliza o que esta vencido.

-- AlterTable
ALTER TABLE "anomalias"
  ADD COLUMN IF NOT EXISTS "numero" VARCHAR(20),
  ADD COLUMN IF NOT EXISTS "prazo" TIMESTAMP(0);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "anomalias_numero_key" ON "anomalias"("numero");
