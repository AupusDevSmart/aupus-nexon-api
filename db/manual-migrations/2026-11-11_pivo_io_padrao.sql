-- Pivô: pontos e I/O PADRÃO da sequência local na TON (docs/IOT-PIVO-TON-LOCAL.md, 11/11/2026).
--   BO01 Bombeamento   | BI01 Pressao_ok
--   BO02 Valvula       | BI02 Tensao_ok
--   BO03 Girar_direita | BI03 Girando_direita
--   BO04 Girar_esquerda| BI04 Girando_esquerda
--   BO05 Percentimetro | BI05 Seguranca  (1 = desalinhado; polaridade = ton_bi.invertido)
--   BO06 Canhao        | BI06 Canhao_ligado
-- 1) Tipo PIVO: lista de pontos nativos = padrão (todos marcados no cadastro).
-- 2) Pivôs existentes: Ligar -> Bombeamento, Pressostato -> Pressao_ok (mantém a BO/BI ligada);
--    cria os que faltam; apaga os antigos SEM BO/BI (Desligar, Desligado, Erro, Ligado, Permissivo).
--    Antigos COM BO/BI ficam (aparecem no SELECT do fim) — Chimarrão PIVO 1/2/3.
-- 3) Lab - NexON / PIV-01 (TON4 a71855ee…): BO1..6 e BI1..6 no padrão; saídas mantidas.
-- O nome "Bombeamento" segue casando com o papel "ligar" da sequência atual do servidor e
-- "Pressao_ok" com o papel "pressao" — a sequência do servidor continua funcionando até a Fase 3.
-- Depois de rodar: pm2 restart aupus-nexon-api NÃO é necessário; abrir a TON no Lab e conferir.
-- Idempotente.
BEGIN;

-- 1) Tipo
UPDATE tipos_equipamentos
SET propriedades_schema = jsonb_set(propriedades_schema, '{pontos_nativos}', '{
  "comando": [
    {"id": "bombeamento",    "label": "Bombeamento"},
    {"id": "valvula",        "label": "Valvula"},
    {"id": "girar_direita",  "label": "Girar_direita"},
    {"id": "girar_esquerda", "label": "Girar_esquerda"},
    {"id": "percentimetro",  "label": "Percentimetro"},
    {"id": "canhao",         "label": "Canhao"}
  ],
  "status": [
    {"id": "pressao_ok",       "label": "Pressao_ok"},
    {"id": "tensao_ok",        "label": "Tensao_ok"},
    {"id": "girando_direita",  "label": "Girando_direita"},
    {"id": "girando_esquerda", "label": "Girando_esquerda"},
    {"id": "seguranca",        "label": "Seguranca"},
    {"id": "canhao_ligado",    "label": "Canhao_ligado"}
  ]
}'::jsonb), updated_at = now()
WHERE codigo = 'PIVO';

CREATE TEMP TABLE _pivos ON COMMIT DROP AS
SELECT e.id FROM equipamentos e LEFT JOIN tipos_equipamentos te ON te.id = e.tipo_equipamento_id
WHERE UPPER(COALESCE(te.codigo, e.tipo_equipamento, '')) LIKE '%PIVO%' AND e.deleted_at IS NULL;

CREATE TEMP TABLE _padrao (tipo varchar(20), nome varchar(100), ordem int, canal int) ON COMMIT DROP;
INSERT INTO _padrao VALUES
  ('comando', 'Bombeamento', 1, 1), ('comando', 'Valvula', 2, 2), ('comando', 'Girar_direita', 3, 3),
  ('comando', 'Girar_esquerda', 4, 4), ('comando', 'Percentimetro', 5, 5), ('comando', 'Canhao', 6, 6),
  ('status', 'Pressao_ok', 1, 1), ('status', 'Tensao_ok', 2, 2), ('status', 'Girando_direita', 3, 3),
  ('status', 'Girando_esquerda', 4, 4), ('status', 'Seguranca', 5, 5), ('status', 'Canhao_ligado', 6, 6);

-- 2a) Renomeia (mantém o vínculo)
UPDATE equipamento_pontos p SET nome = CASE p.nome WHEN 'Ligar' THEN 'Bombeamento' ELSE 'Pressao_ok' END, updated_at = now()
WHERE p.equipamento_id IN (SELECT id FROM _pivos) AND p.nome IN ('Ligar', 'Pressostato')
  AND NOT EXISTS (SELECT 1 FROM equipamento_pontos q WHERE q.equipamento_id = p.equipamento_id
                  AND q.nome = CASE p.nome WHEN 'Ligar' THEN 'Bombeamento' ELSE 'Pressao_ok' END);

-- 2b) Apaga os antigos sem BO/BI
DELETE FROM equipamento_pontos p
WHERE p.equipamento_id IN (SELECT id FROM _pivos)
  AND p.nome IN ('Ligar', 'Desligar', 'Desligado', 'Erro', 'Ligado', 'Permissivo', 'Pressostato')
  AND NOT EXISTS (SELECT 1 FROM ton_bo b WHERE b.equipamento_ponto_id = p.id AND b.deleted_at IS NULL)
  AND NOT EXISTS (SELECT 1 FROM ton_bi b WHERE b.equipamento_ponto_id = p.id AND b.deleted_at IS NULL)
  AND NOT EXISTS (SELECT 1 FROM iot_vinculos v WHERE v.equipamento_ponto_id = p.id AND v.deleted_at IS NULL);

-- 2c) Cria os que faltam (e acerta a ordem)
INSERT INTO equipamento_pontos (id, equipamento_id, tipo, nome, ordem, ativo, created_at, updated_at)
SELECT substr(md5(random()::text || clock_timestamp()::text || pv.id || pd.nome), 1, 26), pv.id, pd.tipo, pd.nome, pd.ordem, true, now(), now()
FROM _pivos pv CROSS JOIN _padrao pd
WHERE NOT EXISTS (SELECT 1 FROM equipamento_pontos q WHERE q.equipamento_id = pv.id AND q.nome = pd.nome);

UPDATE equipamento_pontos p SET ordem = pd.ordem, tipo = pd.tipo, ativo = true, deleted_at = NULL, updated_at = now()
FROM _padrao pd
WHERE p.equipamento_id IN (SELECT id FROM _pivos) AND p.nome = pd.nome
  AND (p.ordem <> pd.ordem OR p.tipo <> pd.tipo OR NOT p.ativo OR p.deleted_at IS NOT NULL);

-- 3) Lab - NexON / PIV-01 na TON4 do lab: I/O padrão
CREATE TEMP TABLE _lab ON COMMIT DROP AS
SELECT 'cmvuy3l1i7jx5jq9z7secirve'::bpchar AS pivo, 'a71855eebbb9eefb75213ab881'::bpchar AS ton;

-- BO: um ponto só numa BO (solta o ponto de outras BOs antes)
UPDATE ton_bo b SET equipamento_ponto_id = NULL, updated_at = now()
WHERE b.deleted_at IS NULL AND b.equipamento_ponto_id IN (
  SELECT p.id FROM equipamento_pontos p, _lab WHERE p.equipamento_id = _lab.pivo AND p.tipo = 'comando')
  AND b.ton_id <> (SELECT ton FROM _lab);
UPDATE ton_bo b SET equipamento_ponto_id = p.id, pulso_ms = 500, ativo = true, updated_at = now()
FROM _padrao pd, equipamento_pontos p, _lab
WHERE b.ton_id = _lab.ton AND b.deleted_at IS NULL AND b.bo_numero = pd.canal AND pd.tipo = 'comando'
  AND p.equipamento_id = _lab.pivo AND p.nome = pd.nome;
INSERT INTO ton_bo (id, ton_id, bo_numero, equipamento_ponto_id, pulso_ms, ativo, created_at, updated_at)
SELECT substr(md5(random()::text || clock_timestamp()::text || pd.nome), 1, 26), _lab.ton, pd.canal, p.id, 500, true, now(), now()
FROM _padrao pd JOIN _lab ON true JOIN equipamento_pontos p ON p.equipamento_id = _lab.pivo AND p.nome = pd.nome
WHERE pd.tipo = 'comando'
  AND NOT EXISTS (SELECT 1 FROM ton_bo b WHERE b.ton_id = _lab.ton AND b.bo_numero = pd.canal AND b.deleted_at IS NULL);

-- BI (todas ativas em alto: invertido = false)
UPDATE ton_bi b SET equipamento_ponto_id = NULL, updated_at = now()
WHERE b.deleted_at IS NULL AND b.equipamento_ponto_id IN (
  SELECT p.id FROM equipamento_pontos p, _lab WHERE p.equipamento_id = _lab.pivo AND p.tipo = 'status')
  AND b.ton_id <> (SELECT ton FROM _lab);
UPDATE ton_bi b SET equipamento_ponto_id = p.id, invertido = false, ativo = true, updated_at = now()
FROM _padrao pd, equipamento_pontos p, _lab
WHERE b.ton_id = _lab.ton AND b.deleted_at IS NULL AND b.bi_numero = pd.canal AND pd.tipo = 'status'
  AND p.equipamento_id = _lab.pivo AND p.nome = pd.nome;
INSERT INTO ton_bi (id, ton_id, bi_numero, equipamento_ponto_id, invertido, ativo, created_at, updated_at)
SELECT substr(md5(random()::text || clock_timestamp()::text || pd.nome), 1, 26), _lab.ton, pd.canal, p.id, false, true, now(), now()
FROM _padrao pd JOIN _lab ON true JOIN equipamento_pontos p ON p.equipamento_id = _lab.pivo AND p.nome = pd.nome
WHERE pd.tipo = 'status'
  AND NOT EXISTS (SELECT 1 FROM ton_bi b WHERE b.ton_id = _lab.ton AND b.bi_numero = pd.canal AND b.deleted_at IS NULL);

-- Espelho iot_vinculos da TON do lab (mesmo que VinculosMirrorService.resyncTonCanais)
DELETE FROM iot_vinculos WHERE fonte_equipamento_id = (SELECT ton FROM _lab) AND fonte_tipo IN ('ton_bo', 'ton_bi');
INSERT INTO iot_vinculos (id, equipamento_ponto_id, fonte_tipo, fonte_equipamento_id, canal, params, ativo, origem)
SELECT substr(md5(random()::text || clock_timestamp()::text || b.id), 1, 26), b.equipamento_ponto_id, 'ton_bo', b.ton_id, b.bo_numero,
       jsonb_build_object('pulso_ms', b.pulso_ms), b.ativo, 'mirror'
FROM ton_bo b WHERE b.ton_id = (SELECT ton FROM _lab) AND b.deleted_at IS NULL AND b.equipamento_ponto_id IS NOT NULL;
INSERT INTO iot_vinculos (id, equipamento_ponto_id, fonte_tipo, fonte_equipamento_id, canal, params, ativo, origem)
SELECT substr(md5(random()::text || clock_timestamp()::text || b.id), 1, 26), b.equipamento_ponto_id, 'ton_bi', b.ton_id, b.bi_numero,
       jsonb_build_object('invertido', b.invertido), b.ativo, 'mirror'
FROM ton_bi b WHERE b.ton_id = (SELECT ton FROM _lab) AND b.deleted_at IS NULL AND b.equipamento_ponto_id IS NOT NULL;

-- Saídas mantidas no PIV-01 (a sequência atual do servidor desliga sem o ponto Desligar)
UPDATE pivo_config SET sequencia = COALESCE(sequencia, '{}'::jsonb) || '{"comandos_mantidos": true}'::jsonb, updated_at = now()
WHERE equipamento_id = (SELECT pivo FROM _lab);

COMMIT;

-- Conferência
SELECT 'BO' || b.bo_numero AS io, p.nome FROM ton_bo b LEFT JOIN equipamento_pontos p ON p.id = b.equipamento_ponto_id
WHERE b.ton_id = 'a71855eebbb9eefb75213ab881' AND b.deleted_at IS NULL
UNION ALL
SELECT 'BI' || b.bi_numero, p.nome FROM ton_bi b LEFT JOIN equipamento_pontos p ON p.id = b.equipamento_ponto_id
WHERE b.ton_id = 'a71855eebbb9eefb75213ab881' AND b.deleted_at IS NULL ORDER BY 1;
-- Pontos antigos que ficaram por ter BO/BI (Chimarrão)
SELECT TRIM(e.nome) AS pivo, p.nome FROM equipamento_pontos p JOIN equipamentos e ON e.id = p.equipamento_id
WHERE p.nome IN ('Ligar', 'Desligar', 'Desligado', 'Erro', 'Ligado', 'Permissivo', 'Pressostato') AND p.deleted_at IS NULL ORDER BY 1, 2;
