-- Recursos da programacao de OS compativeis com os da instrucao.
--
-- Gerado por `prisma migrate diff` e depois editado a mao:
--   * removido o CREATE INDEX em iot_projetos — tabela do iot_nexon, fora desta
--     mudanca. Falso-positivo permanente do diff neste banco compartilhado.
--   * IF NOT EXISTS onde o Postgres aceita, para o script poder rodar de novo.
--
-- NAO E DESTRUTIVO. As tres operacoes so ampliam ou relaxam:
--
--   ferramentas.quantidade  Int -> Decimal(10,3)   alarga, nao perde valor
--   ferramentas.unidade     coluna nova, anulavel
--   tecnicos.nome           NOT NULL -> anulavel   relaxa, nao apaga
--
-- Motivo: a instrucao guarda quantidade decimal COM unidade ("2,5 m de cabo") e
-- descreve o PERFIL do tecnico ("Eletricista"), nao uma pessoa. Herdar esses
-- recursos para a OS exigia arredondar a quantidade, descartar a unidade e
-- inventar um nome vazio.

-- AlterTable
ALTER TABLE "ferramentas_programacao_os"
  ADD COLUMN IF NOT EXISTS "unidade" VARCHAR(20);

ALTER TABLE "ferramentas_programacao_os"
  ALTER COLUMN "quantidade" SET DATA TYPE DECIMAL(10,3),
  ALTER COLUMN "quantidade" SET DEFAULT 1;

-- AlterTable
ALTER TABLE "tecnicos_programacao_os"
  ALTER COLUMN "nome" DROP NOT NULL;

-- ---------------------------------------------------------------------------
-- As tabelas espelho da EXECUCAO.
--
-- A OS copia os recursos da programacao ao ser gerada. Se a origem virasse
-- decimal com unidade e o destino continuasse inteiro sem unidade, a copia
-- truncaria a quantidade — foi o typecheck dessa copia que denunciou.
-- Mesmas tres operacoes, mesma ausencia de risco.
-- ---------------------------------------------------------------------------

ALTER TABLE "ferramentas_os"
  ADD COLUMN IF NOT EXISTS "unidade" VARCHAR(20);

ALTER TABLE "ferramentas_os"
  ALTER COLUMN "quantidade" SET DATA TYPE DECIMAL(10,3),
  ALTER COLUMN "quantidade" SET DEFAULT 1;

ALTER TABLE "tecnicos_os"
  ALTER COLUMN "nome" DROP NOT NULL;
