-- UFV SECADOR: o nó TON do projeto IoT tinha equipamento_id (coluna) = "TON PM"
-- (OLI/GO/CHIMARRAO_SECADOR/PM, offline desde 17/10) e props.equipamento_id = "TON UFV" (a certa).
-- O comando de ajuste resolve a TON pela coluna → ia para a TON PM e dava timeout. Único caso no sistema.
CREATE TABLE IF NOT EXISTS bkp_20261026c_secador_ton AS
  SELECT id, equipamento_id, props FROM iot_componentes WHERE trim(id) = '8a7dd6238788f743b4bc235c0c';
UPDATE iot_componentes SET equipamento_id = 'cmq6lai692m0bjqcfqplnrexc', updated_at = now()
 WHERE trim(id) = '8a7dd6238788f743b4bc235c0c' AND trim(equipamento_id) = 'cmq9ulmsl0fc8jq4nerynfma6';
