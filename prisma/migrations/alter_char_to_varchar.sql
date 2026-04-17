-- Alterar tipo das colunas de CHAR para VARCHAR para evitar padding de espaços

-- veiculo_id
ALTER TABLE programacoes_os
ALTER COLUMN veiculo_id TYPE VARCHAR(26);

-- reserva_id
ALTER TABLE programacoes_os
ALTER COLUMN reserva_id TYPE VARCHAR(26);

-- Limpar espaços existentes
UPDATE programacoes_os
SET veiculo_id = TRIM(veiculo_id)
WHERE veiculo_id IS NOT NULL;

UPDATE programacoes_os
SET reserva_id = TRIM(reserva_id)
WHERE reserva_id IS NOT NULL;
