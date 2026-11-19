-- BANCADA controle MED (Pontal real) — ZERAR DEPOIS.
-- Demanda de CARGA contratada da unidade 2000 → 230 kW, para os gráficos do MED (contratada/tolerância)
-- baterem com o cadastro do controle. Original salvo em bkp_20261119_pontal_contrato (demanda_carga 2000).
-- Voltar: UPDATE unidades u SET demanda_carga = b.demanda_carga FROM bkp_20261119_pontal_contrato b WHERE u.id = b.id;
UPDATE unidades SET demanda_carga = 230 WHERE id = 'cmuhbmzan17mbjq7o8154c6vt';
