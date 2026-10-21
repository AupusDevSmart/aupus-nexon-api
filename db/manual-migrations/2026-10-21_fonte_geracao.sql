-- NEXON-37 — Fonte da geração (TON × nuvem). Ver docs/GERACAO-ANALISE.md, seção "Fonte da geração".
-- Idempotente. O código funciona antes deste SQL: sem a coluna, a fonte é 'automatico' e
-- fixar a fonte devolve 400; sem as colunas do cache, o kWh da TON sai da integral da potência.
-- Rollback:
--   ALTER TABLE unidade_usina_config DROP COLUMN IF EXISTS fonte_geracao;
--   ALTER TABLE geracao_analise_diaria DROP COLUMN IF EXISTS kwh_ton, DROP COLUMN IF EXISTS ton_completa;
BEGIN;

-- Fonte da geração da instalação: automatico (regra do FonteGeracaoService), ton ou nuvem
-- (fixada por admin). Manual/BDO vence qualquer uma.
ALTER TABLE unidade_usina_config
  ADD COLUMN IF NOT EXISTS fonte_geracao text NOT NULL DEFAULT 'automatico';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'unidade_usina_config_fonte_geracao_check'
  ) THEN
    ALTER TABLE unidade_usina_config
      ADD CONSTRAINT unidade_usina_config_fonte_geracao_check
      CHECK (fonte_geracao IN ('automatico', 'ton', 'nuvem'));
  END IF;
END $$;

-- Cache diário da análise: kWh da TON (Σ MAX(daily_yield) dos inversores, sem linhas da
-- nuvem) e se a TON cobriu ≥ 70% do período solar. A nuvem NÃO entra no cache: a escolha da
-- fonte é refeita a cada leitura (a nuvem chega às 21h).
ALTER TABLE geracao_analise_diaria
  ADD COLUMN IF NOT EXISTS kwh_ton numeric(14, 3),
  ADD COLUMN IF NOT EXISTS ton_completa boolean;

COMMIT;
