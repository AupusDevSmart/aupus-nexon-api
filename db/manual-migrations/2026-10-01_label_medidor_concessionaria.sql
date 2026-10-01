-- 2026-10-01 — Medidor Concessionária UNIFICADO na paleta IoT: liga no Gateway A966 (TON v1)
-- OU direto numa TON v2 pela Saida Serial de Usuario (cabo SSU). O "Medidor SSU" separado
-- saiu da paleta. Rótulo volta a ser só "Medidor Concessionária"; targets/hint registram as
-- duas ligações (a validação real é no editor). JÁ APLICADO em produção em 01/10; idempotente.
UPDATE tipos_equipamentos
   SET propriedades_schema = jsonb_set(
         jsonb_set(
           jsonb_set(propriedades_schema, '{label}', '"Medidor Concessionária"'),
           '{conn,targets}', '["meter_gateway","ton"]'),
         '{conn,hint}', '"Medidor Concessionária liga no Gateway A966 ou direto numa TON v2 (SSU)"'),
       updated_at = now()
 WHERE id = 'cmsyybblg000jjq1qr1na33zz' AND propriedades_schema->>'palette_key' = 'medidor_comum';
