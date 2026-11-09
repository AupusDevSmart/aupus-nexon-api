-- Bancada (projeto IoT 9ef55b08…): volta o PIV-01 para a TON4v2 e deixa a TON4 (V1) de lado.
--
-- O que aconteceu (09/11): a TON4v2 saiu do diagrama e entrou uma TON4 (V1).
--   1. Os 11 pontos do PIV-01 foram vinculados às BO/BI da TON4 sem sair da TON4v2 → cada ponto
--      ficou com 2 vínculos ativos e o comando escolhia qualquer um (Ligar foi na TON4v2,
--      Desligar na TON4). Corrigido no código: vincular um ponto o tira das outras BO/BI.
--   2. A TON4 ficou com o tópico do gateway (AUPUS/BANCADA): satélite sem MAC herdou a base.
--      Comando para ela ia para a TON2 (gateway sem relés → no_relays_in_model).
--
-- Este script (idempotente):
--   - solta os pontos das BO/BI da TON4 (as linhas de BO/BI ficam, vazias); valem os da TON4v2;
--   - tira o tópico da TON4 (até ela ter MAC, não recebe comando);
--   - devolve o registro de presença do gateway à TON2.
-- O equipamento TON4v2 (9c8d026…) e os vínculos dela não foram apagados: não mexe neles.
BEGIN;

UPDATE ton_bo SET equipamento_ponto_id = NULL, updated_at = now()
WHERE TRIM(ton_id) = 'a71855eebbb9eefb75213ab881' AND equipamento_ponto_id IS NOT NULL AND deleted_at IS NULL;

UPDATE ton_bi SET equipamento_ponto_id = NULL, updated_at = now()
WHERE TRIM(ton_id) = 'a71855eebbb9eefb75213ab881' AND equipamento_ponto_id IS NOT NULL AND deleted_at IS NULL;

DELETE FROM iot_vinculos
WHERE TRIM(fonte_equipamento_id) = 'a71855eebbb9eefb75213ab881' AND fonte_tipo IN ('ton_bo', 'ton_bi');

UPDATE equipamentos SET topico_mqtt = NULL, mqtt_habilitado = false, updated_at = now()
WHERE id = 'a71855eebbb9eefb75213ab881';

UPDATE iot_dispositivos_online SET device_name = 'TON2', componente_id = 'c1957c460d5d400010ebe4f257', updated_at = now()
WHERE topico_mqtt = 'AUPUS/BANCADA';

-- Conferência: pontos do PIV-01 por TON (esperado: só TON4v2, 6 BO + 5 BI) e tópico da TON4 vazio
SELECT f.nome AS ton, v.fonte_tipo, count(*) AS pontos
FROM iot_vinculos v
JOIN equipamento_pontos p ON p.id = v.equipamento_ponto_id
JOIN equipamentos f ON f.id = v.fonte_equipamento_id
WHERE p.equipamento_id = 'cmvuy3l1i7jx5jq9z7secirve' AND v.deleted_at IS NULL AND v.ativo
GROUP BY 1, 2 ORDER BY 1, 2;
SELECT nome, coalesce(topico_mqtt, '(sem tópico)') AS topico FROM equipamentos WHERE id = 'a71855eebbb9eefb75213ab881';

COMMIT;
