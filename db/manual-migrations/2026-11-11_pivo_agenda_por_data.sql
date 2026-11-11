\set ON_ERROR_STOP on

-- Agenda do pivô POR DATA (NEXON-98): a planilha sobe uma linha por irrigação, do ano todo.
--
-- Até aqui a programação era só semanal (dias da semana + hora). Duas colunas novas em
-- pivo_programacoes, as duas opcionais — o que já existe não muda:
--   data     — preenchida: a linha vale SÓ naquele dia (dias é ignorado). Nula: semanal, como antes.
--   lote_id  — o envio da planilha que criou a linha (para listar, trocar ou apagar junto).
--
-- Aplicar ANTES de publicar o código: a listagem e o tick passam a ler `data`.
-- Idempotente.

BEGIN;

ALTER TABLE public.pivo_programacoes ADD COLUMN IF NOT EXISTS data date;
ALTER TABLE public.pivo_programacoes ADD COLUMN IF NOT EXISTS lote_id char(26);

COMMENT ON COLUMN public.pivo_programacoes.data IS 'Agenda por data (NEXON-98): a linha dispara só neste dia, no fuso America/Sao_Paulo. NULL = programação semanal.';
COMMENT ON COLUMN public.pivo_programacoes.lote_id IS 'Envio da planilha que criou a linha (NEXON-98).';

CREATE INDEX IF NOT EXISTS pivo_programacoes_data_idx
  ON public.pivo_programacoes (equipamento_id, data)
  WHERE deleted_at IS NULL AND data IS NOT NULL;

COMMIT;
