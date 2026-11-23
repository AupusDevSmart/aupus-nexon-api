-- Parcial da SSU em 30 s (controle pelo MED): duração da parcial em segundos (60 = formato antigo).
ALTER TABLE ssu_minutos ADD COLUMN IF NOT EXISTS dur smallint NOT NULL DEFAULT 60;
