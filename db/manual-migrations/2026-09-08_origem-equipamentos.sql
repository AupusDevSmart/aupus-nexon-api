-- Reestrutura Fase 2: coluna `origem` em equipamentos (unifilar | iot | ambos).
-- Substitui a classificação-em-código do front (dominioEquipamento.ts). Semeada pelas
-- LISTAS do usuário (autoritativas): iot = Power Meter/Relé/TON/A966; ambos = Inversor/
-- Carregador/Bomba/Pivô (comuns aos dois — 6.3); resto = unifilar. Nada lê a coluna ainda,
-- então não muda comportamento atual.

ALTER TABLE equipamentos ADD COLUMN IF NOT EXISTS origem varchar(12) NOT NULL DEFAULT 'unifilar';

-- iot (dispositivo de aquisição, não aparece no unifilar)
UPDATE equipamentos SET origem='iot'
 WHERE TRIM(tipo_equipamento_id) IN (SELECT TRIM(id) FROM tipos_equipamentos
   WHERE nome IN ('Power Meter','Relé de Proteção','TON','A966'));

-- ambos (aparece nos dois mundos — inversor/carregador/bomba/pivô)
UPDATE equipamentos SET origem='ambos'
 WHERE TRIM(tipo_equipamento_id) IN (SELECT TRIM(id) FROM tipos_equipamentos
   WHERE nome IN ('Inversor Fotovoltaico','Carregador Elétrico','Bomba de Combustível','Pivô de Irrigação'));

-- sem tipo mas com MQTT (os device órfãos: Inversor/Rele/Power Meter soltos) -> iot
UPDATE equipamentos SET origem='iot'
 WHERE tipo_equipamento_id IS NULL AND mqtt_habilitado = true AND origem='unifilar';

-- SANITY
\echo '--- distribuição de origem (ativos) ---'
SELECT origem, count(*) FILTER (WHERE deleted_at IS NULL) AS ativos, count(*) AS total
  FROM equipamentos GROUP BY origem ORDER BY origem;
\echo '--- por tipo x origem (confere consistência) ---'
SELECT COALESCE(t.nome,'(sem tipo)') tipo, e.origem, count(*) FILTER (WHERE e.deleted_at IS NULL) ativos
  FROM equipamentos e LEFT JOIN tipos_equipamentos t ON TRIM(e.tipo_equipamento_id)=TRIM(t.id)
  GROUP BY 1,2 ORDER BY 1,2;
