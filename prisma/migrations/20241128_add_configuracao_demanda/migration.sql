-- CreateTable
CREATE TABLE "configuracao_demanda" (
    "id" CHAR(26) NOT NULL,
    "unidade_id" CHAR(26) NOT NULL,
    "fonte" VARCHAR(20) NOT NULL DEFAULT 'AGRUPAMENTO',
    "equipamentos_ids" JSON NOT NULL,
    "mostrar_detalhes" BOOLEAN NOT NULL DEFAULT true,
    "intervalo_atualizacao" INTEGER NOT NULL DEFAULT 30,
    "aplicar_perdas" BOOLEAN NOT NULL DEFAULT true,
    "fator_perdas" DECIMAL(5,2) NOT NULL DEFAULT 3.0,
    "valor_contratado" DECIMAL(10,2),
    "percentual_adicional" DECIMAL(5,2) DEFAULT 10.0,
    "created_at" TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" CHAR(26),
    "updated_by" CHAR(26),

    CONSTRAINT "configuracao_demanda_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "configuracao_demanda_unidade_id_key" ON "configuracao_demanda"("unidade_id");

-- CreateIndex
CREATE INDEX "idx_configuracao_demanda_unidade" ON "configuracao_demanda"("unidade_id");

-- AddForeignKey
ALTER TABLE "configuracao_demanda" ADD CONSTRAINT "fk_configuracao_demanda_unidade" FOREIGN KEY ("unidade_id") REFERENCES "unidades"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "configuracao_demanda" ADD CONSTRAINT "fk_configuracao_demanda_created_by" FOREIGN KEY ("created_by") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "configuracao_demanda" ADD CONSTRAINT "fk_configuracao_demanda_updated_by" FOREIGN KEY ("updated_by") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;