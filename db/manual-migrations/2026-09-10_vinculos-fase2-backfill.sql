-- ============================================================================
-- Fase 7 / arqIoT — VÍNCULO unificado, FASE 2: BACKFILL.
--
-- Copia para iot_vinculos o que já existe nos quatro stores. NÃO altera nem
-- apaga nada nas origens (ton_bo/ton_bi/ton_ai/io_config seguem intactos e
-- continuam sendo a verdade). Ninguém lê iot_vinculos ainda.
--
-- Idempotente: limpa o que veio de backfill antes de recarregar.
-- ROLLBACK: DELETE FROM iot_vinculos WHERE origem = 'backfill';
-- ============================================================================

BEGIN;

DELETE FROM iot_vinculos WHERE origem = 'backfill';

-- 1) ton_bo → comando por saída digital da TON -------------------------------
INSERT INTO iot_vinculos (id, equipamento_ponto_id, fonte_tipo, fonte_equipamento_id,
                          canal, params, ativo, origem, created_at, updated_at)
SELECT substr(md5(random()::text || clock_timestamp()::text || b.id), 1, 26),
       b.equipamento_ponto_id, 'ton_bo', b.ton_id, b.bo_numero,
       jsonb_build_object('pulso_ms', b.pulso_ms),
       b.ativo, 'backfill', b.created_at, b.updated_at
FROM ton_bo b
JOIN equipamento_pontos p ON p.id = b.equipamento_ponto_id AND p.deleted_at IS NULL
JOIN equipamentos e       ON e.id = b.ton_id               AND e.deleted_at IS NULL
WHERE b.deleted_at IS NULL AND b.equipamento_ponto_id IS NOT NULL;

-- 2) ton_bi → status por entrada digital da TON ------------------------------
INSERT INTO iot_vinculos (id, equipamento_ponto_id, fonte_tipo, fonte_equipamento_id,
                          canal, params, ativo, origem, created_at, updated_at)
SELECT substr(md5(random()::text || clock_timestamp()::text || b.id), 1, 26),
       b.equipamento_ponto_id, 'ton_bi', b.ton_id, b.bi_numero,
       jsonb_build_object('invertido', b.invertido),
       b.ativo, 'backfill', b.created_at, b.updated_at
FROM ton_bi b
JOIN equipamento_pontos p ON p.id = b.equipamento_ponto_id AND p.deleted_at IS NULL
JOIN equipamentos e       ON e.id = b.ton_id               AND e.deleted_at IS NULL
WHERE b.deleted_at IS NULL AND b.equipamento_ponto_id IS NOT NULL;

-- 3) ton_ai → medição por entrada analógica da TON ---------------------------
INSERT INTO iot_vinculos (id, equipamento_ponto_id, fonte_tipo, fonte_equipamento_id,
                          canal, params, ativo, origem, created_at, updated_at)
SELECT substr(md5(random()::text || clock_timestamp()::text || a.id), 1, 26),
       a.equipamento_ponto_id, 'ton_ai', a.ton_id, a.ai_numero,
       jsonb_build_object('mv_0', a.mv_0, 'mv_100', a.mv_100),
       a.ativo, 'backfill', a.created_at, a.updated_at
FROM ton_ai a
JOIN equipamento_pontos p ON p.id = a.equipamento_ponto_id AND p.deleted_at IS NULL
JOIN equipamentos e       ON e.id = a.ton_id               AND e.deleted_at IS NULL
WHERE a.deleted_at IS NULL AND a.equipamento_ponto_id IS NOT NULL;

-- 4) io_config.bo → comando por coil/registrador de device Modbus ------------
--    Chave do mapa = cmd_id (que hoje é o próprio ponto_id). O device é
--    referenciado pelo EQUIPAMENTO (id estável), não pelo componente.
INSERT INTO iot_vinculos (id, equipamento_ponto_id, fonte_tipo, fonte_equipamento_id,
                          canal, sinal, params, ativo, origem)
SELECT DISTINCT ON (TRIM(kv.value->>'ponto_id'))
       substr(md5(random()::text || clock_timestamp()::text || c.id || kv.key), 1, 26),
       TRIM(kv.value->>'ponto_id'), 'modbus_bo',
       COALESCE(NULLIF(TRIM(c.equipamento_id), ''), c.props->>'equipamento_id'),
       NULL, kv.key,
       (kv.value - 'equipamento_id' - 'ponto_id'),
       true, 'backfill'
FROM iot_componentes c
CROSS JOIN LATERAL jsonb_each(COALESCE(c.props->'io_config'->'bo', '{}'::jsonb)) kv
JOIN equipamento_pontos p ON p.id = TRIM(kv.value->>'ponto_id') AND p.deleted_at IS NULL
JOIN equipamentos e       ON e.id = COALESCE(NULLIF(TRIM(c.equipamento_id), ''), c.props->>'equipamento_id')
                          AND e.deleted_at IS NULL
WHERE COALESCE(kv.value->>'ponto_id', '') <> '';

-- 5) io_config.bi → status por bit de device Modbus --------------------------
--    `papel` grava explicitamente o que hoje é INFERIDO POR REGEX na chave
--    (statusFonteDoDisjuntor procura /aberto/i e /fechado/i).
INSERT INTO iot_vinculos (id, equipamento_ponto_id, fonte_tipo, fonte_equipamento_id,
                          canal, sinal, papel, params, ativo, origem)
SELECT DISTINCT ON (TRIM(kv.value->>'ponto_id'), kv.key)
       substr(md5(random()::text || clock_timestamp()::text || c.id || kv.key), 1, 26),
       TRIM(kv.value->>'ponto_id'), 'modbus_bi',
       COALESCE(NULLIF(TRIM(c.equipamento_id), ''), c.props->>'equipamento_id'),
       NULL, kv.key,
       CASE WHEN kv.key ~* 'aberto'  THEN 'aberto'
            WHEN kv.key ~* 'fechado' THEN 'fechado'
            ELSE NULL END,
       (kv.value - 'equipamento_id' - 'ponto_id'),
       true, 'backfill'
FROM iot_componentes c
CROSS JOIN LATERAL jsonb_each(COALESCE(c.props->'io_config'->'bi', '{}'::jsonb)) kv
JOIN equipamento_pontos p ON p.id = TRIM(kv.value->>'ponto_id') AND p.deleted_at IS NULL
JOIN equipamentos e       ON e.id = COALESCE(NULLIF(TRIM(c.equipamento_id), ''), c.props->>'equipamento_id')
                          AND e.deleted_at IS NULL
WHERE COALESCE(kv.value->>'ponto_id', '') <> '';

COMMIT;
