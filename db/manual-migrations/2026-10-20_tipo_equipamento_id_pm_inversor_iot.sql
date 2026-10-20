-- PM e inversor auto-criados pelo IoT nasciam só com tipo_equipamento (texto) e sem
-- tipo_equipamento_id → sem categoria: caíam em "Não entra no agregado" na demanda e
-- ficavam fora do COA. Preenche o tipo cadastrado (o iot.service já passa a criar assim).
CREATE TABLE IF NOT EXISTS bkp_20261020_tipo_equip_iot AS
  SELECT id, tipo_equipamento, tipo_equipamento_id FROM equipamentos
  WHERE deleted_at IS NULL AND tipo_equipamento_id IS NULL
    AND tipo_equipamento IN ('POWER_METER', 'INVERSOR', 'tipo-meter-m160-001');

UPDATE equipamentos SET tipo_equipamento_id = 'tipo-meter-m160-001', updated_at = now()
WHERE deleted_at IS NULL AND tipo_equipamento_id IS NULL
  AND tipo_equipamento IN ('POWER_METER', 'tipo-meter-m160-001');

UPDATE equipamentos SET tipo_equipamento_id = '01JAQTE1INVERSOR000000005', updated_at = now()
WHERE deleted_at IS NULL AND tipo_equipamento_id IS NULL AND tipo_equipamento = 'INVERSOR';
