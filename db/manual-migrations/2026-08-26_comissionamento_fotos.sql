-- Fotos de prova do comissionamento (evidência: display do equipamento × NexON).
-- Array jsonb de { url, nome, por, em }. Arquivos em uploads/comissionamento/.
ALTER TABLE iot_comissionamento ADD COLUMN IF NOT EXISTS fotos jsonb NOT NULL DEFAULT '[]'::jsonb;
