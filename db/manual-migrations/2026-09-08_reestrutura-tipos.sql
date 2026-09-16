-- Reestrutura Fase 1: consolida 43 tipos -> 15 canônicos + apaga cruft.
-- FK equipamentos.tipo_equipamento_id -> tipos_equipamentos é RESTRICT:
-- por isso remapeamos TODOS os equip (ativos+deletados) antes de apagar tipos.
-- Renomear preserva o id (diagramas não quebram). Backup em db/backups/2026-09-08_pre-reestrutura/.

-- ===== A) CONSOLIDAÇÕES (remapeia todos os equip dos irmãos -> canônico) =====
UPDATE equipamentos SET tipo_equipamento_id=(SELECT id FROM tipos_equipamentos WHERE nome='Disjuntor')
 WHERE TRIM(tipo_equipamento_id) IN (SELECT TRIM(id) FROM tipos_equipamentos WHERE nome IN ('Disjuntor Fechado (Energizado)','Disjuntor Aberto (Desenergizado)'));

UPDATE equipamentos SET tipo_equipamento_id=(SELECT id FROM tipos_equipamentos WHERE nome='Transformador')
 WHERE TRIM(tipo_equipamento_id) IN (SELECT TRIM(id) FROM tipos_equipamentos WHERE nome IN ('Transformador de Serviço Auxiliar'));

UPDATE equipamentos SET tipo_equipamento_id=(SELECT id FROM tipos_equipamentos WHERE nome='Inversor Solar')
 WHERE TRIM(tipo_equipamento_id) IN (SELECT TRIM(id) FROM tipos_equipamentos WHERE nome IN ('Inversor Solar Sungrow','Inversor Huawei'));
UPDATE tipos_equipamentos SET nome='Inversor Fotovoltaico', updated_at=now() WHERE nome='Inversor Solar';

UPDATE tipos_equipamentos SET nome='Módulo Fotovoltaico', updated_at=now() WHERE nome='Painel Solar Fotovoltaico';
UPDATE tipos_equipamentos SET nome='Pivô de Irrigação',   updated_at=now() WHERE nome='Pivô Central de Irrigação';
UPDATE tipos_equipamentos SET nome='Power Meter',         updated_at=now() WHERE nome='Medidor M160';
UPDATE tipos_equipamentos SET nome='Medidor Concess',     updated_at=now() WHERE nome='Equatorial';

UPDATE equipamentos SET tipo_equipamento_id=(SELECT id FROM tipos_equipamentos WHERE nome='IMS A966')
 WHERE TRIM(tipo_equipamento_id) IN (SELECT TRIM(id) FROM tipos_equipamentos WHERE nome IN ('Gateway IoT A-966'));
UPDATE tipos_equipamentos SET nome='A966', updated_at=now() WHERE nome='IMS A966';

UPDATE equipamentos SET tipo_equipamento_id=(SELECT id FROM tipos_equipamentos WHERE nome='Chave Fusível')
 WHERE TRIM(tipo_equipamento_id) IN (SELECT TRIM(id) FROM tipos_equipamentos WHERE nome IN ('Chave Seccionadora Aberta','Chave Seccionadora Fechada'));
UPDATE tipos_equipamentos SET nome='Chave', updated_at=now() WHERE nome='Chave Fusível';

UPDATE equipamentos SET tipo_equipamento_id=(SELECT id FROM tipos_equipamentos WHERE nome='Carregador Elétrico Genérico')
 WHERE TRIM(tipo_equipamento_id) IN (SELECT TRIM(id) FROM tipos_equipamentos WHERE nome IN ('RISE ULTRAFAST CARREGADOR DC'));
UPDATE tipos_equipamentos SET nome='Carregador Elétrico', updated_at=now() WHERE nome='Carregador Elétrico Genérico';

UPDATE tipos_equipamentos SET nome='Banco de Capacitor', updated_at=now() WHERE nome='Banco de Capacitores';

-- ===== B) APAGAR (têm equip ativo): soft-delete o equipamento =====
UPDATE equipamentos SET deleted_at=now(), updated_at=now()
 WHERE deleted_at IS NULL AND TRIM(tipo_equipamento_id) IN
   (SELECT TRIM(id) FROM tipos_equipamentos WHERE nome IN ('SSW07','Conjunto de manobra','QGBT AUTO PORTANTE','Barramento Elétrico'));

-- ===== C) Destacar (NULL) refs restantes dos tipos a apagar (libera o FK RESTRICT) =====
UPDATE equipamentos SET tipo_equipamento_id=NULL
 WHERE TRIM(tipo_equipamento_id) IN (SELECT TRIM(id) FROM tipos_equipamentos WHERE nome IN (
   'Disjuntor Fechado (Energizado)','Disjuntor Aberto (Desenergizado)','Transformador de Serviço Auxiliar',
   'Inversor Solar Sungrow','Inversor Huawei','Gateway IoT A-966','Chave Seccionadora Aberta','Chave Seccionadora Fechada','RISE ULTRAFAST CARREGADOR DC',
   'SSW07','Conjunto de manobra','QGBT AUTO PORTANTE','Barramento Elétrico',
   'Banco de Baterias','Botoeira de Comando','Canadian','Landis Gyr','Landis+Gyr E750','Medidor de Energia','Multimeter M300','Painel PMT','Ponto de Junção','Retificador','SKID de Equipamentos','Sala de Comando','Sistema SCADA','Sistema de CFTV','Sistema de Telecomunicações'));

-- ===== D) Apagar os tipos órfãos =====
DELETE FROM tipos_equipamentos WHERE nome IN (
   'Disjuntor Fechado (Energizado)','Disjuntor Aberto (Desenergizado)','Transformador de Serviço Auxiliar',
   'Inversor Solar Sungrow','Inversor Huawei','Gateway IoT A-966','Chave Seccionadora Aberta','Chave Seccionadora Fechada','RISE ULTRAFAST CARREGADOR DC',
   'SSW07','Conjunto de manobra','QGBT AUTO PORTANTE','Barramento Elétrico',
   'Banco de Baterias','Botoeira de Comando','Canadian','Landis Gyr','Landis+Gyr E750','Medidor de Energia','Multimeter M300','Painel PMT','Ponto de Junção','Retificador','SKID de Equipamentos','Sala de Comando','Sistema SCADA','Sistema de CFTV','Sistema de Telecomunicações');

-- ===== SANITY =====
\echo '--- tipos restantes (esperado 15) ---'
SELECT count(*) AS tipos_restantes FROM tipos_equipamentos;
\echo '--- catálogo final (nome, equip ativos) ---'
SELECT t.nome, count(e.id) FILTER (WHERE e.deleted_at IS NULL) AS ativos
  FROM tipos_equipamentos t LEFT JOIN equipamentos e ON TRIM(e.tipo_equipamento_id)=TRIM(t.id)
  GROUP BY t.nome ORDER BY t.nome;
\echo '--- equip ATIVOS sem tipo (esperado 0) ---'
SELECT count(*) AS ativos_sem_tipo FROM equipamentos WHERE tipo_equipamento_id IS NULL AND deleted_at IS NULL;
