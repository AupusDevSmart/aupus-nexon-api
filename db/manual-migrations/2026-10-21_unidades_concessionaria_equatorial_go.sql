-- Todas as unidades atendidas são da Equatorial Goiás (confirmado pelo produto em 21/10/2026).
-- FK = concessionarias_energia (não a tabela concessionarias). 42 já estavam; completa as 8 sem.
-- Só preenche quem está sem concessionária. Reverter: restaurar de bkp_20261021_unidades_concessionaria.
CREATE TABLE IF NOT EXISTS bkp_20261021_unidades_concessionaria AS
  SELECT id, concessionaria_id FROM unidades WHERE concessionaria_id IS NULL;

UPDATE unidades SET concessionaria_id = 'cmhl10gd600002f9scnek0gva', updated_at = now()
WHERE concessionaria_id IS NULL;
