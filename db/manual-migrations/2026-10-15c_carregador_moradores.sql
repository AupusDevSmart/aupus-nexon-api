-- NEXON-5: carregador do condomínio igual ao mockup web — validade do acesso do
-- morador (vencimento automático + aviso 1 dia antes), e-mail/usuário do morador
-- (perfil Morador), valor do kWh gravado na recarga e bateria do carro.
-- Idempotente.
-- ROLLBACK:
--   ALTER TABLE moradores DROP COLUMN validade, DROP COLUMN email, DROP COLUMN usuario_id, DROP COLUMN aviso_validade_em;
--   ALTER TABLE carregador_sessoes DROP COLUMN tarifa_kwh, DROP COLUMN soc_inicio;
--   ALTER TABLE carregador_config DROP COLUMN ultimo_soc, DROP COLUMN ultimo_soc_em, DROP COLUMN capacidade_bateria_kwh;
ALTER TABLE moradores ADD COLUMN IF NOT EXISTS validade date;
ALTER TABLE moradores ADD COLUMN IF NOT EXISTS email varchar(160);
ALTER TABLE moradores ADD COLUMN IF NOT EXISTS usuario_id char(26);
ALTER TABLE moradores ADD COLUMN IF NOT EXISTS aviso_validade_em timestamp(0) without time zone;
CREATE INDEX IF NOT EXISTS idx_moradores_usuario ON moradores(usuario_id);
ALTER TABLE carregador_sessoes ADD COLUMN IF NOT EXISTS tarifa_kwh numeric;
ALTER TABLE carregador_sessoes ADD COLUMN IF NOT EXISTS soc_inicio numeric;
ALTER TABLE carregador_config ADD COLUMN IF NOT EXISTS ultimo_soc numeric;
ALTER TABLE carregador_config ADD COLUMN IF NOT EXISTS ultimo_soc_em timestamp(0) without time zone;
ALTER TABLE carregador_config ADD COLUMN IF NOT EXISTS capacidade_bateria_kwh numeric;
-- Recargas já fechadas guardam o valor do kWh de hoje (não serão recalculadas se a tarifa mudar).
UPDATE carregador_sessoes s SET tarifa_kwh = c.tarifa_kwh
FROM carregador_config c WHERE TRIM(c.equipamento_id) = TRIM(s.equipamento_id) AND s.tarifa_kwh IS NULL AND c.tarifa_kwh IS NOT NULL;
