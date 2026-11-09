-- Bancada: PIV-01 passa da TON4v2 (98:A3:16:EB:E1:A0) para a TON4 V1 (98:A3:16:EB:DC:10).
--
--   1. TON4 V1 ganha o MAC (visto no heartbeat via gateway) e o tópico de satélite;
--   2. os 11 pontos do PIV-01 saem das BO/BI da TON4v2 e entram nas MESMAS BO/BI da TON4
--      (mesma numeração; o tempo de pulso de cada BO vem junto);
--   3. o espelho iot_vinculos das duas TONs é refeito a partir de ton_bo/ton_bi
--      (mesma regra do VinculosMirrorService.resyncTonCanais).
-- A TON4v2 continua cadastrada, com as BO/BI vazias. Idempotente.
BEGIN;

UPDATE equipamentos
SET mac_address = '98:A3:16:EB:DC:10', topico_mqtt = 'AUPUS/BANCADA/satellite/98:A3:16:EB:DC:10',
    mqtt_habilitado = true, updated_at = now()
WHERE id = 'a71855eebbb9eefb75213ab881';

-- BO: ponto + pulso da TON4v2 → mesma BO da TON4
UPDATE ton_bo t SET equipamento_ponto_id = v.equipamento_ponto_id, pulso_ms = v.pulso_ms, updated_at = now()
FROM ton_bo v
WHERE TRIM(t.ton_id) = 'a71855eebbb9eefb75213ab881' AND TRIM(v.ton_id) = '9c8d026adeb44c77474b6a8979'
  AND t.bo_numero = v.bo_numero AND t.deleted_at IS NULL AND v.deleted_at IS NULL
  AND v.equipamento_ponto_id IN (SELECT id FROM equipamento_pontos WHERE equipamento_id = 'cmvuy3l1i7jx5jq9z7secirve');
UPDATE ton_bo SET equipamento_ponto_id = NULL, updated_at = now()
WHERE TRIM(ton_id) = '9c8d026adeb44c77474b6a8979' AND deleted_at IS NULL
  AND equipamento_ponto_id IN (SELECT id FROM equipamento_pontos WHERE equipamento_id = 'cmvuy3l1i7jx5jq9z7secirve');

-- BI: ponto + invertido da TON4v2 → mesma BI da TON4
UPDATE ton_bi t SET equipamento_ponto_id = v.equipamento_ponto_id, invertido = v.invertido, updated_at = now()
FROM ton_bi v
WHERE TRIM(t.ton_id) = 'a71855eebbb9eefb75213ab881' AND TRIM(v.ton_id) = '9c8d026adeb44c77474b6a8979'
  AND t.bi_numero = v.bi_numero AND t.deleted_at IS NULL AND v.deleted_at IS NULL
  AND v.equipamento_ponto_id IN (SELECT id FROM equipamento_pontos WHERE equipamento_id = 'cmvuy3l1i7jx5jq9z7secirve');
UPDATE ton_bi SET equipamento_ponto_id = NULL, updated_at = now()
WHERE TRIM(ton_id) = '9c8d026adeb44c77474b6a8979' AND deleted_at IS NULL
  AND equipamento_ponto_id IN (SELECT id FROM equipamento_pontos WHERE equipamento_id = 'cmvuy3l1i7jx5jq9z7secirve');

-- Espelho (iot_vinculos) das duas TONs, refeito da fonte
DELETE FROM iot_vinculos
WHERE TRIM(fonte_equipamento_id) IN ('a71855eebbb9eefb75213ab881', '9c8d026adeb44c77474b6a8979') AND fonte_tipo IN ('ton_bo', 'ton_bi');
INSERT INTO iot_vinculos (id, equipamento_ponto_id, fonte_tipo, fonte_equipamento_id, canal, params, ativo, origem)
SELECT substr(md5(random()::text || b.id), 1, 26), TRIM(b.equipamento_ponto_id), 'ton_bo', TRIM(b.ton_id), b.bo_numero,
       jsonb_build_object('pulso_ms', b.pulso_ms), b.ativo, 'mirror'
FROM ton_bo b
WHERE TRIM(b.ton_id) IN ('a71855eebbb9eefb75213ab881', '9c8d026adeb44c77474b6a8979') AND b.deleted_at IS NULL AND b.equipamento_ponto_id IS NOT NULL;
INSERT INTO iot_vinculos (id, equipamento_ponto_id, fonte_tipo, fonte_equipamento_id, canal, params, ativo, origem)
SELECT substr(md5(random()::text || b.id), 1, 26), TRIM(b.equipamento_ponto_id), 'ton_bi', TRIM(b.ton_id), b.bi_numero,
       jsonb_build_object('invertido', b.invertido), b.ativo, 'mirror'
FROM ton_bi b
WHERE TRIM(b.ton_id) IN ('a71855eebbb9eefb75213ab881', '9c8d026adeb44c77474b6a8979') AND b.deleted_at IS NULL AND b.equipamento_ponto_id IS NOT NULL;

-- Conferência: esperado só TON4 (ton_bi 5, ton_bo 6) e o tópico de satélite da TON4
SELECT f.nome AS ton, v.fonte_tipo, count(*) AS pontos
FROM iot_vinculos v
JOIN equipamento_pontos p ON p.id = v.equipamento_ponto_id
JOIN equipamentos f ON f.id = v.fonte_equipamento_id
WHERE p.equipamento_id = 'cmvuy3l1i7jx5jq9z7secirve' AND v.deleted_at IS NULL AND v.ativo
GROUP BY 1, 2 ORDER BY 1, 2;
SELECT nome, mac_address, topico_mqtt FROM equipamentos WHERE id = 'a71855eebbb9eefb75213ab881';

COMMIT;
