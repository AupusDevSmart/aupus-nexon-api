-- AddColumn: Adicionar campos para agregação de 1 minuto

-- Campos para dados agregados de 1 minuto
ALTER TABLE "equipamentos_dados" ADD COLUMN "timestamp_fim" TIMESTAMP(0);
ALTER TABLE "equipamentos_dados" ADD COLUMN "num_leituras" INTEGER;

-- Comentários para documentação
COMMENT ON COLUMN "equipamentos_dados"."timestamp_fim" IS 'Timestamp final do período de 1 minuto de agregação';
COMMENT ON COLUMN "equipamentos_dados"."num_leituras" IS 'Número de leituras MQTT agregadas no período de 1 minuto';
