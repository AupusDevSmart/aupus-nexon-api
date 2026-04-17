-- Migration: add_unidades_new_fields
-- Description: Add new fields to unidades table: irrigante, grupo, subgrupo, tipo_unidade, demanda_carga, demanda_geracao, concessionaria_id

-- Add new columns to unidades table
ALTER TABLE "unidades"
ADD COLUMN IF NOT EXISTS "irrigante" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "grupo" VARCHAR(1),
ADD COLUMN IF NOT EXISTS "subgrupo" VARCHAR(50),
ADD COLUMN IF NOT EXISTS "tipo_unidade" VARCHAR(20),
ADD COLUMN IF NOT EXISTS "demanda_carga" DECIMAL(10, 2),
ADD COLUMN IF NOT EXISTS "demanda_geracao" DECIMAL(10, 2),
ADD COLUMN IF NOT EXISTS "concessionaria_id" CHAR(26);

-- Add foreign key constraint for concessionaria_id
ALTER TABLE "unidades"
ADD CONSTRAINT "unidades_concessionaria_id_fkey"
FOREIGN KEY ("concessionaria_id")
REFERENCES "concessionarias_energia"("id")
ON DELETE SET NULL
ON UPDATE CASCADE;

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS "unidades_concessionaria_id_idx" ON "unidades"("concessionaria_id");
CREATE INDEX IF NOT EXISTS "unidades_grupo_idx" ON "unidades"("grupo");
CREATE INDEX IF NOT EXISTS "unidades_tipo_unidade_idx" ON "unidades"("tipo_unidade");

-- Add comments to document the columns
COMMENT ON COLUMN "unidades"."irrigante" IS 'Indica se a unidade é irrigante';
COMMENT ON COLUMN "unidades"."grupo" IS 'Grupo tarifário: A ou B';
COMMENT ON COLUMN "unidades"."subgrupo" IS 'Subgrupo tarifário: A4_VERDE, A3a_VERDE ou B';
COMMENT ON COLUMN "unidades"."tipo_unidade" IS 'Tipo da unidade de energia: Carga ou Geração';
COMMENT ON COLUMN "unidades"."demanda_carga" IS 'Demanda de carga em kW (quando tipo_unidade é Carga)';
COMMENT ON COLUMN "unidades"."demanda_geracao" IS 'Demanda de geração em kW (quando tipo_unidade é Geração)';
COMMENT ON COLUMN "unidades"."concessionaria_id" IS 'ID da concessionária de energia relacionada';
