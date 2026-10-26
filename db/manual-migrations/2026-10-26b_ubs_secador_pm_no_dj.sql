-- UBS + UFV e SECADOR + UFV: o PM sai do DESENHO do unifilar (continua existindo: é ele que guarda as
-- leituras) e a medição dele passa a aparecer no DJ da carga — mesmo padrão dos Pivôs 4 a 6 (NSA):
--   UBS + UFV     : PM UBS (PM-01, cmq9g31i…)        → DJ UBS (52.3, cmrkx80xu…)
--   SECADOR + UFV : Medidor M160 1 (PM-01, cmq9g7r3…) → DJ-CARGA (cmvpmhjgz…)
-- = vínculo PM→DJ no IoT (props.disjuntor_equipamento_id) + DJ com SCS e medição 'pm'.
-- No Secador o nó do PM no IoT (projeto "PM - SECADOR") nem tinha equipamento_id: vinculado aqui.
-- Backup: bkp_20261026b_pm_dj_*. ROLLBACK no fim.
BEGIN;
CREATE TABLE IF NOT EXISTS bkp_20261026b_pm_dj_equipamentos AS SELECT * FROM equipamentos WITH NO DATA;
CREATE TABLE IF NOT EXISTS bkp_20261026b_pm_dj_conexoes AS SELECT * FROM equipamentos_conexoes WITH NO DATA;
CREATE TABLE IF NOT EXISTS bkp_20261026b_pm_dj_iot AS SELECT id, equipamento_id, props FROM iot_componentes WITH NO DATA;
INSERT INTO bkp_20261026b_pm_dj_equipamentos SELECT * FROM equipamentos WHERE id IN (
  'cmq9g31i207r7jq4ntoef8deu','cmrkx80xu00m2jqzharrh2h4z','cmq9g7r3o07vkjq4nk8rvdu9m','cmvpmhjgz05jhjqaxoz713jk1');
INSERT INTO bkp_20261026b_pm_dj_conexoes SELECT * FROM equipamentos_conexoes WHERE trim(id) = 'cmvju1xpx3rt9jqmy5hfjnjch';
INSERT INTO bkp_20261026b_pm_dj_iot SELECT id, equipamento_id, props FROM iot_componentes WHERE trim(id) IN (
  '7720c712944d5ef58b62d872a3','1b55550d943df08c1a20f7bb30');

-- PMs fora do desenho (a ligação PM-01 → linha do 52.3 sai; o ponto de junção só existia por ela)
UPDATE equipamentos_conexoes SET deleted_at = now(), updated_at = now() WHERE trim(id) = 'cmvju1xpx3rt9jqmy5hfjnjch';
UPDATE equipamentos SET diagrama_id = NULL, posicao_x = NULL, posicao_y = NULL, rotacao = NULL, label_position = NULL, updated_at = now()
 WHERE id IN ('cmq9g31i207r7jq4ntoef8deu','cmq9g7r3o07vkjq4nk8rvdu9m');

-- Medição do PM no DJ
UPDATE iot_componentes SET props = props || '{"disjuntor_equipamento_id": "cmrkx80xu00m2jqzharrh2h4z"}'::jsonb, updated_at = now()
 WHERE trim(id) = '7720c712944d5ef58b62d872a3';   -- PM UBS → 52.3
UPDATE iot_componentes SET props = props || '{"equipamento_id": "cmq9g7r3o07vkjq4nk8rvdu9m", "disjuntor_equipamento_id": "cmvpmhjgz05jhjqaxoz713jk1"}'::jsonb,
       equipamento_id = 'cmq9g7r3o07vkjq4nk8rvdu9m', updated_at = now()
 WHERE trim(id) = '1b55550d943df08c1a20f7bb30';   -- PM Secador → DJ-CARGA
UPDATE equipamentos SET scs = true, scs_medicao = 'pm', updated_at = now()
 WHERE id IN ('cmrkx80xu00m2jqzharrh2h4z','cmvpmhjgz05jhjqaxoz713jk1');
COMMIT;

-- ROLLBACK:
-- BEGIN;
-- UPDATE equipamentos e SET diagrama_id=b.diagrama_id, posicao_x=b.posicao_x, posicao_y=b.posicao_y, rotacao=b.rotacao,
--   label_position=b.label_position, scs=b.scs, scs_medicao=b.scs_medicao FROM bkp_20261026b_pm_dj_equipamentos b WHERE b.id=e.id;
-- UPDATE equipamentos_conexoes c SET deleted_at=b.deleted_at FROM bkp_20261026b_pm_dj_conexoes b WHERE b.id=c.id;
-- UPDATE iot_componentes c SET props=b.props, equipamento_id=b.equipamento_id FROM bkp_20261026b_pm_dj_iot b WHERE b.id=c.id;
-- COMMIT;
