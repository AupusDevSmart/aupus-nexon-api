-- Pivô: 6 comandos (ajuste da 2026-11-04_pivo_pontos_bomba_valvula).
-- O painel faz a bomba e a solenoide: "Ligar" dá a partida (bomba + solenoide) e o
-- "Desligar" do pivô para tudo. Saem Desligar_bomba e Valvula; Ligar_bomba vira Ligar e
-- Bomba_ligada vira Ligado. docs/IOT-PIVO-LIGAR-BOMBA-CANHAO.md.
--   comando: Girar_direita, Girar_esquerda, Desligar, Percentimetro, Ligar, Canhao
--   status : Girando_direita, Girando_esquerda, Desligado, Erro, Pressostato,
--            Ligado, Canhao_ligado, Permissivo
-- Idempotente.
BEGIN;

-- 1) Lista do tipo
UPDATE tipos_equipamentos t
SET propriedades_schema = jsonb_set(t.propriedades_schema, '{pontos_nativos,comando}', (
      SELECT COALESCE(jsonb_agg(CASE WHEN x->>'id' = 'ligar_bomba'
                                     THEN '{"id": "ligar", "label": "Ligar", "padrao": false}'::jsonb ELSE x END ORDER BY o), '[]'::jsonb)
      FROM jsonb_array_elements(t.propriedades_schema->'pontos_nativos'->'comando') WITH ORDINALITY AS e(x, o)
      WHERE x->>'id' NOT IN ('desligar_bomba', 'valvula'))),
    updated_at = now()
WHERE t.codigo = 'PIVO' AND t.propriedades_schema ? 'pontos_nativos';

UPDATE tipos_equipamentos t
SET propriedades_schema = jsonb_set(t.propriedades_schema, '{pontos_nativos,status}', (
      SELECT COALESCE(jsonb_agg(CASE WHEN x->>'id' = 'bomba_ligada'
                                     THEN '{"id": "ligado", "label": "Ligado", "padrao": false}'::jsonb ELSE x END ORDER BY o), '[]'::jsonb)
      FROM jsonb_array_elements(t.propriedades_schema->'pontos_nativos'->'status') WITH ORDINALITY AS e(x, o))),
    updated_at = now()
WHERE t.codigo = 'PIVO' AND t.propriedades_schema ? 'pontos_nativos';

-- 2) Pontos já criados nos pivôs (renomear mantém a BO/BI ligada)
WITH pivos AS (
  SELECT e.id FROM equipamentos e LEFT JOIN tipos_equipamentos te ON te.id = e.tipo_equipamento_id
  WHERE UPPER(COALESCE(te.codigo, e.tipo_equipamento, '')) LIKE '%PIVO%'
)
UPDATE equipamento_pontos p SET nome = CASE p.nome WHEN 'Ligar_bomba' THEN 'Ligar' ELSE 'Ligado' END, updated_at = now()
WHERE p.equipamento_id IN (SELECT id FROM pivos)
  AND p.nome IN ('Ligar_bomba', 'Bomba_ligada')
  AND NOT EXISTS (SELECT 1 FROM equipamento_pontos q WHERE q.equipamento_id = p.equipamento_id
                  AND q.nome = CASE p.nome WHEN 'Ligar_bomba' THEN 'Ligar' ELSE 'Ligado' END);

-- Desligar_bomba / Valvula sem BO ligada: apaga (com BO ligada fica, e aparece no SELECT abaixo)
WITH pivos AS (
  SELECT e.id FROM equipamentos e LEFT JOIN tipos_equipamentos te ON te.id = e.tipo_equipamento_id
  WHERE UPPER(COALESCE(te.codigo, e.tipo_equipamento, '')) LIKE '%PIVO%'
)
DELETE FROM equipamento_pontos p
WHERE p.equipamento_id IN (SELECT id FROM pivos)
  AND p.nome IN ('Desligar_bomba', 'Valvula')
  AND NOT EXISTS (SELECT 1 FROM ton_bo b WHERE b.equipamento_ponto_id = p.id AND b.deleted_at IS NULL);

COMMIT;

SELECT propriedades_schema->'pontos_nativos' FROM tipos_equipamentos WHERE codigo = 'PIVO';
-- Sobras (deveria vir vazio)
SELECT TRIM(e.nome) AS pivo, p.nome FROM equipamento_pontos p JOIN equipamentos e ON e.id = p.equipamento_id
WHERE p.nome IN ('Ligar_bomba', 'Bomba_ligada', 'Desligar_bomba', 'Valvula') AND p.deleted_at IS NULL;
