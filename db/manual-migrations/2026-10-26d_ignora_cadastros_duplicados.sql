-- Cadastros ANTIGOS duplicados (tópico do firmware velho) que apareciam como "sem comunicação" no
-- quadro do COA, embora o equipamento físico comunique por outro cadastro:
--   NSA Pivos 4 a 6: PIVO 4/5/6 ("Medidor M160 N", …/M160/N, último 14/03) → reais: Medidor 4/5/6 (…/Power_Meter_N)
--                    "Power Meter" (…/Power Meter_3, último 30/07)          → real: Medidor 6
--   Silos e Secador: "INV 2" (…/INVERSOR/2, último 23/01)                    → real: Inversor Solar 2 (…/Inversor_2)
-- Ignorar = sai dos alarmes e do quadro (reversível: ignorar=false). Não apaga histórico.
CREATE TABLE IF NOT EXISTS bkp_20261026d_limiar AS
  SELECT * FROM alarme_comunicacao_limiar WHERE equipamento_id IN (
    'cmkbk4a17006z2fqciyehzk0r','cmkbo6aat000rjqheyihkmexw','cmkbo6r7y000zjqheyunurfie','4e5c29135388b0984d93396334','cmklcc7zz1n2ujq8jrkozgit2');
INSERT INTO alarme_comunicacao_limiar (equipamento_id, ignorar)
SELECT x, true FROM unnest(ARRAY['cmkbk4a17006z2fqciyehzk0r','cmkbo6aat000rjqheyihkmexw','cmkbo6r7y000zjqheyunurfie','4e5c29135388b0984d93396334','cmklcc7zz1n2ujq8jrkozgit2']) AS x
ON CONFLICT (equipamento_id) DO UPDATE SET ignorar = true;
UPDATE logs_mqtt SET resolvido_em = now()
WHERE equipamento_id IN ('cmkbk4a17006z2fqciyehzk0r','cmkbo6aat000rjqheyihkmexw','cmkbo6r7y000zjqheyunurfie','4e5c29135388b0984d93396334','cmklcc7zz1n2ujq8jrkozgit2')
  AND tipo = 'alerta' AND resolvido_em IS NULL AND (dados_snapshot->>'origem') = 'comunicacao';
