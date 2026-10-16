-- Unifilares (todas as plantas):
--  1) O A-966 não é mais equipamento de unifilar: todo A-966 (IMS_A966) DESENHADO vira
--     Medidor Concessionária (EQTL001) — troca de TIPO no lugar (mantém posição, ligações,
--     tópico e histórico; a ingestão trata EQTL001 com pulsos da SSU igual ao A-966).
--     Nomes "IMS A966 N" passam a "MED-CONC" (padrão do Lab/Prevest).
--  2) Painéis solares (PAINEL_SOLAR) saem do unifilar — basta o inversor. Soft-delete do
--     painel e da(s) ligação(ões) dele (nenhum tem dado; cada um só liga no inversor).
-- Backup: bkp_20261016_unifilar_equipamentos / _conexoes. ROLLBACK no fim.
-- Simular sem gravar: sed 's/^COMMIT;$/ROLLBACK;/' este_arquivo | psql ...
BEGIN;
CREATE TABLE IF NOT EXISTS bkp_20261016_unifilar_equipamentos AS SELECT * FROM equipamentos WITH NO DATA;
CREATE TABLE IF NOT EXISTS bkp_20261016_unifilar_conexoes AS SELECT * FROM equipamentos_conexoes WITH NO DATA;

-- alvos
CREATE TEMP TABLE alvo_a966 ON COMMIT DROP AS
SELECT e.id FROM equipamentos e JOIN tipos_equipamentos t ON t.id = e.tipo_equipamento_id
WHERE t.codigo = 'IMS_A966' AND e.deleted_at IS NULL AND e.posicao_x IS NOT NULL;

CREATE TEMP TABLE alvo_painel ON COMMIT DROP AS
SELECT e.id FROM equipamentos e JOIN tipos_equipamentos t ON t.id = e.tipo_equipamento_id
WHERE t.codigo = 'PAINEL_SOLAR' AND e.deleted_at IS NULL AND e.posicao_x IS NOT NULL;

INSERT INTO bkp_20261016_unifilar_equipamentos
SELECT * FROM equipamentos WHERE id IN (SELECT id FROM alvo_a966 UNION SELECT id FROM alvo_painel);
INSERT INTO bkp_20261016_unifilar_conexoes
SELECT * FROM equipamentos_conexoes c
WHERE c.deleted_at IS NULL
  AND (c.equipamento_origem_id IN (SELECT id FROM alvo_painel) OR c.equipamento_destino_id IN (SELECT id FROM alvo_painel));

-- 1) A-966 → Medidor Concessionária
UPDATE equipamentos e
SET tipo_equipamento_id = (SELECT id FROM tipos_equipamentos WHERE codigo = 'EQTL001'),
    tipo_equipamento   = 'EQTL001',
    nome = CASE WHEN TRIM(e.nome) ILIKE 'IMS A966%' THEN 'MED-CONC' ELSE e.nome END,
    updated_at = now()
WHERE e.id IN (SELECT id FROM alvo_a966);

-- 2) Painéis solares fora do unifilar
UPDATE equipamentos_conexoes c SET deleted_at = now(), updated_at = now()
WHERE c.deleted_at IS NULL
  AND (c.equipamento_origem_id IN (SELECT id FROM alvo_painel) OR c.equipamento_destino_id IN (SELECT id FROM alvo_painel));
UPDATE equipamentos SET deleted_at = now(), updated_at = now() WHERE id IN (SELECT id FROM alvo_painel);

-- resumo
SELECT 'A966 → Medidor Concessionária' AS acao, COUNT(*) FROM alvo_a966
UNION ALL SELECT 'painéis removidos', COUNT(*) FROM alvo_painel
UNION ALL SELECT 'ligações de painel removidas', COUNT(*) FROM bkp_20261016_unifilar_conexoes;
COMMIT;

-- ROLLBACK:
-- BEGIN;
-- UPDATE equipamentos e SET tipo_equipamento_id = b.tipo_equipamento_id, tipo_equipamento = b.tipo_equipamento,
--   nome = b.nome, deleted_at = b.deleted_at FROM bkp_20261016_unifilar_equipamentos b WHERE b.id = e.id;
-- UPDATE equipamentos_conexoes c SET deleted_at = b.deleted_at FROM bkp_20261016_unifilar_conexoes b WHERE b.id = c.id;
-- COMMIT;
