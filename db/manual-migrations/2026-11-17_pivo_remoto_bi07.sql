-- Pivô: chave LOCAL/REMOTO do painel na BI07 (17/11/2026).
--   Ponto de status "Remoto": continuidade (1) = REMOTO -> a TON/NexON NÃO liga o pivô
--   (Ligar, reinício, agenda, retomada da ponta e comando direto de Bombeamento/Girar).
--   Irrigação em curso segue normal se a chave mudar; Desligar sempre vale.
--   Pivô sem o ponto ligado a uma BI = sem trava. Ponto ligado mas sem leitura = recusa ligar.
-- 1) Tipo PIVO: "Remoto" entra nos pontos nativos de status.
-- 2) Cria o ponto "Remoto" (ordem 7) em todos os pivôs (sem BI = sem efeito).
-- 3) Lab - NexON / PIV-01: Remoto -> BI07 da TON4v2 f435b9cb… (ativa em alto).
-- Demais pivôs: salvar a Topologia IoT liga Remoto na BI07 livre (TON com 7+ entradas) ou
-- ligar à mão no Configurar I/O da TON. Idempotente. Precisa pm2 restart (código novo).
BEGIN;

-- 1) Tipo
UPDATE tipos_equipamentos
SET propriedades_schema = jsonb_set(propriedades_schema, '{pontos_nativos,status}',
      (propriedades_schema->'pontos_nativos'->'status') || '[{"id": "remoto", "label": "Remoto"}]'::jsonb),
    updated_at = now()
WHERE codigo = 'PIVO'
  AND NOT (propriedades_schema->'pontos_nativos'->'status') @> '[{"id": "remoto"}]'::jsonb;

-- 2) Ponto em todos os pivôs
INSERT INTO equipamento_pontos (id, equipamento_id, tipo, nome, ordem, ativo, created_at, updated_at)
SELECT substr(md5(random()::text || clock_timestamp()::text || e.id), 1, 26), e.id, 'status', 'Remoto', 7, true, now(), now()
FROM equipamentos e LEFT JOIN tipos_equipamentos te ON te.id = e.tipo_equipamento_id
WHERE UPPER(COALESCE(te.codigo, e.tipo_equipamento, '')) LIKE '%PIVO%' AND e.deleted_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM equipamento_pontos q WHERE q.equipamento_id = e.id AND q.nome = 'Remoto' AND q.deleted_at IS NULL);

-- 3) Lab PIV-01 -> BI07 da TON4v2 do Lab
CREATE TEMP TABLE _lab ON COMMIT DROP AS
SELECT 'cmvuy3l1i7jx5jq9z7secirve'::bpchar AS pivo, 'f435b9cb4550ca70aed193f217'::bpchar AS ton,
       (SELECT id FROM equipamento_pontos WHERE equipamento_id = 'cmvuy3l1i7jx5jq9z7secirve' AND nome = 'Remoto' AND deleted_at IS NULL LIMIT 1) AS ponto;

UPDATE ton_bi b SET equipamento_ponto_id = _lab.ponto, invertido = false, ativo = true, updated_at = now()
FROM _lab WHERE b.ton_id = _lab.ton AND b.bi_numero = 7 AND b.deleted_at IS NULL AND b.equipamento_ponto_id IS NULL;
INSERT INTO ton_bi (id, ton_id, bi_numero, equipamento_ponto_id, invertido, ativo, created_at, updated_at)
SELECT substr(md5(random()::text || clock_timestamp()::text || 'remoto'), 1, 26), _lab.ton, 7, _lab.ponto, false, true, now(), now()
FROM _lab WHERE _lab.ponto IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM ton_bi b WHERE b.ton_id = _lab.ton AND b.bi_numero = 7 AND b.deleted_at IS NULL);

-- Espelho iot_vinculos (mesmo que VinculosMirrorService.resyncTonCanais)
INSERT INTO iot_vinculos (id, equipamento_ponto_id, fonte_tipo, fonte_equipamento_id, canal, params, ativo, origem)
SELECT substr(md5(random()::text || clock_timestamp()::text || b.id), 1, 26), b.equipamento_ponto_id, 'ton_bi', b.ton_id, b.bi_numero,
       jsonb_build_object('invertido', b.invertido), b.ativo, 'mirror'
FROM ton_bi b, _lab
WHERE b.ton_id = _lab.ton AND b.bi_numero = 7 AND b.deleted_at IS NULL AND b.equipamento_ponto_id = _lab.ponto
  AND NOT EXISTS (SELECT 1 FROM iot_vinculos v WHERE v.equipamento_ponto_id = b.equipamento_ponto_id AND v.fonte_tipo = 'ton_bi' AND v.deleted_at IS NULL);

COMMIT;

-- Conferência
SELECT 'BI' || b.bi_numero AS io, p.nome, b.invertido FROM ton_bi b LEFT JOIN equipamento_pontos p ON p.id = b.equipamento_ponto_id
WHERE b.ton_id = 'f435b9cb4550ca70aed193f217' AND b.deleted_at IS NULL ORDER BY b.bi_numero;
