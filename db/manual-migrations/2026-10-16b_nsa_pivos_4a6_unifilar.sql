-- NS Aparecida · "Pivos 4 a 6" — unifilar enxuto:
--  1) Power Meters (Medidor 4/5/6) saem do DESENHO, mas continuam existindo (são eles que
--     guardam as leituras). A medição de cada um passa a aparecer no DJ abaixo dele:
--       Medidor 6 (PM end. 3) → D6 · Medidor 5 (PM end. 2) → D5 · Medidor 4 (PM end. 1) → D4
--     = vínculo PM→DJ do IoT (props.disjuntor_equipamento_id) + DJ com SCS e medição 'pm'.
--  2) Motores (MIT 4/5/6) saem; a linha do DJ vai direto ao pivô. Motores sem dado/vínculo.
-- Backup: bkp_20261016b_nsa_*. ROLLBACK no fim.
BEGIN;
CREATE TABLE IF NOT EXISTS bkp_20261016b_nsa_equipamentos AS SELECT * FROM equipamentos WITH NO DATA;
CREATE TABLE IF NOT EXISTS bkp_20261016b_nsa_conexoes AS SELECT * FROM equipamentos_conexoes WITH NO DATA;
CREATE TABLE IF NOT EXISTS bkp_20261016b_nsa_iot AS SELECT id, props FROM iot_componentes WITH NO DATA;

INSERT INTO bkp_20261016b_nsa_equipamentos SELECT * FROM equipamentos WHERE id IN (
  'cmlu10wgo02ldjq56us8fhz9t','cmlu0rqu402jtjq56ldigoup0','cmlu0oobi02jbjq5654ur3ksi',   -- Medidor 4/5/6
  'cmlu0gqmc02hqjq56ulatonzx','cmlu0ibls02i7jq56kija1vp8','cmlu0iotf02idjq56zeiuphxs',   -- Motores (MIT 6/5/4)
  'cmlu150ds02lxjq56clizkhny','cmlu13x4f02lpjq566samjk85','cmlu13bjm02ljjq56ppt0h83b');  -- D4/D5/D6
INSERT INTO bkp_20261016b_nsa_conexoes SELECT * FROM equipamentos_conexoes WHERE trim(id) IN (
  'cms7p6nlm1f6tjq5zai5x9r2i','cms7p6nlm1f6zjq5zmbpiqi41','cms7p6nlm1f72jq5zuiv2hndx','cms7p6nln1f76jq5zdhk58r98',
  'cms7p6nln1f74jq5zd7x3pr14','cms7p6nln1f77jq5zvbrwr1qj',
  'cms7p6nlm1f6ujq5zheqkqxd0','cms7p6nlm1f71jq5zaw0g0zem','cms7p6nln1f75jq5zjipfvvyj');
INSERT INTO bkp_20261016b_nsa_iot SELECT id, props FROM iot_componentes WHERE trim(id) IN (
  'da468ab506a5f22fdcfd3d78dd','e98a05362546e939a8bc0902f5','584d6530efc434159b7eb9152a');

-- 2) Motores fora: a ligação de cima (DJ ↔ motor) passa a ir no pivô; a de baixo sai.
UPDATE equipamentos_conexoes SET equipamento_origem_id = 'cmlu0w0zd02krjq56011guyiz', porta_origem = 'top', updated_at = now()
 WHERE trim(id) = 'cms7p6nlm1f6zjq5zmbpiqi41';   -- (MIT 6 top → D6 bottom) vira (Pivô 6 top → D6 bottom)
UPDATE equipamentos_conexoes SET equipamento_destino_id = 'cmlu15vmi02lzjq56zs4uugwz', porta_destino = 'top', updated_at = now()
 WHERE trim(id) = 'cms7p6nlm1f72jq5zuiv2hndx';   -- D5 → MIT 5  vira  D5 → Pivô 5
UPDATE equipamentos_conexoes SET equipamento_destino_id = 'cmlu1674w02m5jq56ghvg4wrf', porta_destino = 'top', updated_at = now()
 WHERE trim(id) = 'cms7p6nln1f74jq5zd7x3pr14';   -- D4 → MIT 4  vira  D4 → Pivô 4
UPDATE equipamentos_conexoes SET deleted_at = now(), updated_at = now()
 WHERE trim(id) IN ('cms7p6nlm1f6tjq5zai5x9r2i','cms7p6nln1f76jq5zdhk58r98','cms7p6nln1f77jq5zvbrwr1qj');  -- motor → pivô
UPDATE equipamentos SET deleted_at = now(), updated_at = now()
 WHERE id IN ('cmlu0gqmc02hqjq56ulatonzx','cmlu0ibls02i7jq56kija1vp8','cmlu0iotf02idjq56zeiuphxs');

-- 1) Power Meters fora do desenho (continuam existindo, com as leituras) …
UPDATE equipamentos_conexoes SET deleted_at = now(), updated_at = now()
 WHERE trim(id) IN ('cms7p6nlm1f6ujq5zheqkqxd0','cms7p6nlm1f71jq5zaw0g0zem','cms7p6nln1f75jq5zjipfvvyj');
UPDATE equipamentos SET diagrama_id = NULL, posicao_x = NULL, posicao_y = NULL, rotacao = NULL, label_position = NULL, updated_at = now()
 WHERE id IN ('cmlu10wgo02ldjq56us8fhz9t','cmlu0rqu402jtjq56ldigoup0','cmlu0oobi02jbjq5654ur3ksi');
-- … e a medição deles aparece no DJ de baixo (vínculo PM→DJ + DJ com SCS de medição PM)
UPDATE iot_componentes SET props = props || '{"disjuntor_equipamento_id": "cmlu13bjm02ljjq56ppt0h83b"}'::jsonb, updated_at = now()
 WHERE trim(id) = 'da468ab506a5f22fdcfd3d78dd';   -- Medidor 6 → D6
UPDATE iot_componentes SET props = props || '{"disjuntor_equipamento_id": "cmlu13x4f02lpjq566samjk85"}'::jsonb, updated_at = now()
 WHERE trim(id) = 'e98a05362546e939a8bc0902f5';   -- Medidor 5 → D5
UPDATE iot_componentes SET props = props || '{"disjuntor_equipamento_id": "cmlu150ds02lxjq56clizkhny"}'::jsonb, updated_at = now()
 WHERE trim(id) = '584d6530efc434159b7eb9152a';   -- Medidor 4 → D4
UPDATE equipamentos SET scs = true, scs_medicao = 'pm', updated_at = now()
 WHERE id IN ('cmlu150ds02lxjq56clizkhny','cmlu13x4f02lpjq566samjk85','cmlu13bjm02ljjq56ppt0h83b');
COMMIT;

-- ROLLBACK:
-- BEGIN;
-- UPDATE equipamentos e SET deleted_at=b.deleted_at, diagrama_id=b.diagrama_id, posicao_x=b.posicao_x, posicao_y=b.posicao_y,
--   rotacao=b.rotacao, label_position=b.label_position, scs=b.scs, scs_medicao=b.scs_medicao
--   FROM bkp_20261016b_nsa_equipamentos b WHERE b.id=e.id;
-- UPDATE equipamentos_conexoes c SET equipamento_origem_id=b.equipamento_origem_id, porta_origem=b.porta_origem,
--   equipamento_destino_id=b.equipamento_destino_id, porta_destino=b.porta_destino, deleted_at=b.deleted_at
--   FROM bkp_20261016b_nsa_conexoes b WHERE b.id=c.id;
-- UPDATE iot_componentes c SET props=b.props FROM bkp_20261016b_nsa_iot b WHERE b.id=c.id;
-- COMMIT;
