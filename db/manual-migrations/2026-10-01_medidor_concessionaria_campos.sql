-- 2026-10-01 — Medidor Concessionária (paleta IoT) tinha os CAMPOS DO POWER METER (Modbus,
-- escalas, TC/TP e modelos M160/PM1200/PD666). Medidor da concessionária é tipo Landis E750,
-- lido pela Saida Serial de Usuario (NBR 14522) — via Gateway A966 ou direto na TON v2.
-- Campos = os que o gerador da TON v2 lê (_processSsu). Modelo: família gateway_medidor sem o
-- próprio A966 (a966-ssu é o gateway, não o medidor). JÁ APLICADO em produção em 01/10; idempotente.
UPDATE tipos_equipamentos
   SET propriedades_schema = jsonb_set(jsonb_set(propriedades_schema,
         '{fields}', '[
           {"key":"name","type":"text","label":"Nome"},
           {"key":"catalog_id","type":"device_select","label":"Modelo do medidor","device_type":"gateway_medidor","excluir":["a966-ssu"]},
           {"key":"ke","type":"number","label":"Ke — kWh por pulso (vazio = do modelo/backend)","placeholder":"ex: 0.048"},
           {"key":"formato_esperado","type":"select","label":"Formato da SSU (só validação; a TON autodetecta)","options":[["auto","Autodetectar"],["estendido","Estendido (9 octetos, 4 quadrantes)"],["normal","Normal (8 octetos, sem quadrante)"]]},
           {"key":"tem_geracao","type":"toggle","label":"Instalação com geração (exige bloco estendido)"},
           {"key":"intervalo_reativo_min","type":"number","label":"Intervalo reativo do medidor (min)","placeholder":"60"}
         ]'::jsonb),
         '{defaults}', '{"name":"Medidor","catalog_id":"","modbus_address":1,"ke":"","formato_esperado":"auto","tem_geracao":true,"intervalo_reativo_min":60,"equipamento_id":""}'::jsonb),
       updated_at = now()
 WHERE id = 'cmsyybblg000jjq1qr1na33zz' AND propriedades_schema->>'palette_key' = 'medidor_comum';
