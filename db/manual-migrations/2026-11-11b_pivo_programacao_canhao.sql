\set ON_ERROR_STOP on

-- Canhão final na agenda do pivô (NEXON-98).
--
-- A programação (semanal ou por data) guardava só sentido, percentímetro, água e duração: quem
-- agendava com o canhão ligado na tela via o pivô ligar SEM o canhão. Uma coluna nova, opcional —
-- o que já existe continua como estava (canhão desligado).
--   canhao — true: a programação liga o canhão final junto com o pivô (só vale com água).
--
-- Aplicar ANTES de publicar o código: a listagem e o tick passam a ler `canhao`.
-- Idempotente. ROLLBACK: ALTER TABLE public.pivo_programacoes DROP COLUMN IF EXISTS canhao;

BEGIN;

ALTER TABLE public.pivo_programacoes ADD COLUMN IF NOT EXISTS canhao boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.pivo_programacoes.canhao IS 'Liga o canhão final junto com o pivô (NEXON-98). Só vale com água.';

COMMIT;
