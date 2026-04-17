-- AlterTable: Add junction point support to equipamentos_conexoes
-- Allow connections to have origem/destino as either equipment OR grid point

-- Step 1: Make equipamento_origem_id and equipamento_destino_id nullable
ALTER TABLE "equipamentos_conexoes" ALTER COLUMN "equipamento_origem_id" DROP NOT NULL;
ALTER TABLE "equipamentos_conexoes" ALTER COLUMN "equipamento_destino_id" DROP NOT NULL;

-- Step 2: Add new fields for junction point support
ALTER TABLE "equipamentos_conexoes" ADD COLUMN "origem_tipo" VARCHAR(20) DEFAULT 'equipamento';
ALTER TABLE "equipamentos_conexoes" ADD COLUMN "origem_grid_x" INTEGER;
ALTER TABLE "equipamentos_conexoes" ADD COLUMN "origem_grid_y" INTEGER;

ALTER TABLE "equipamentos_conexoes" ADD COLUMN "destino_tipo" VARCHAR(20) DEFAULT 'equipamento';
ALTER TABLE "equipamentos_conexoes" ADD COLUMN "destino_grid_x" INTEGER;
ALTER TABLE "equipamentos_conexoes" ADD COLUMN "destino_grid_y" INTEGER;

-- Step 3: Update existing records to have origem_tipo = 'equipamento' and destino_tipo = 'equipamento'
UPDATE "equipamentos_conexoes" SET "origem_tipo" = 'equipamento' WHERE "origem_tipo" IS NULL;
UPDATE "equipamentos_conexoes" SET "destino_tipo" = 'equipamento' WHERE "destino_tipo" IS NULL;
