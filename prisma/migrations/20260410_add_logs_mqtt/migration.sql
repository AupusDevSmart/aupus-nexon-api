-- CreateTable: regras_logs_mqtt
CREATE TABLE IF NOT EXISTS "regras_logs_mqtt" (
    "id" CHAR(26) NOT NULL,
    "equipamento_id" CHAR(26) NOT NULL,
    "nome" VARCHAR(100) NOT NULL,
    "campo_json" VARCHAR(255) NOT NULL,
    "operador" VARCHAR(10) NOT NULL,
    "valor" DECIMAL(15,4) NOT NULL,
    "mensagem" VARCHAR(500) NOT NULL,
    "severidade" VARCHAR(20) NOT NULL DEFAULT 'MEDIA',
    "cooldown_minutos" INTEGER NOT NULL DEFAULT 5,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(0),

    CONSTRAINT "regras_logs_mqtt_pkey" PRIMARY KEY ("id")
);

-- CreateTable: logs_mqtt
CREATE TABLE IF NOT EXISTS "logs_mqtt" (
    "id" CHAR(26) NOT NULL,
    "regra_id" CHAR(26) NOT NULL,
    "equipamento_id" CHAR(26) NOT NULL,
    "valor_lido" DECIMAL(15,4) NOT NULL,
    "mensagem" VARCHAR(500) NOT NULL,
    "severidade" VARCHAR(20) NOT NULL,
    "dados_snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "logs_mqtt_pkey" PRIMARY KEY ("id")
);

-- Indexes: regras_logs_mqtt
CREATE INDEX IF NOT EXISTS "regras_logs_mqtt_equipamento_id_idx" ON "regras_logs_mqtt"("equipamento_id");
CREATE INDEX IF NOT EXISTS "regras_logs_mqtt_ativo_idx" ON "regras_logs_mqtt"("ativo");

-- Indexes: logs_mqtt
CREATE INDEX IF NOT EXISTS "logs_mqtt_regra_id_idx" ON "logs_mqtt"("regra_id");
CREATE INDEX IF NOT EXISTS "logs_mqtt_equipamento_id_idx" ON "logs_mqtt"("equipamento_id");
CREATE INDEX IF NOT EXISTS "logs_mqtt_created_at_idx" ON "logs_mqtt"("created_at" DESC);
CREATE INDEX IF NOT EXISTS "logs_mqtt_severidade_idx" ON "logs_mqtt"("severidade");

-- ForeignKeys
ALTER TABLE "regras_logs_mqtt" ADD CONSTRAINT "regras_logs_mqtt_equipamento_id_fkey"
    FOREIGN KEY ("equipamento_id") REFERENCES "equipamentos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "logs_mqtt" ADD CONSTRAINT "logs_mqtt_regra_id_fkey"
    FOREIGN KEY ("regra_id") REFERENCES "regras_logs_mqtt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "logs_mqtt" ADD CONSTRAINT "logs_mqtt_equipamento_id_fkey"
    FOREIGN KEY ("equipamento_id") REFERENCES "equipamentos"("id") ON DELETE CASCADE ON UPDATE CASCADE;
