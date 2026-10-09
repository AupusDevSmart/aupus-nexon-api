-- 2026-10-09 — SETPOINTS de inversor (comando com VALOR): limite de potência ativa, fator de
-- potência, reativo e endereço Modbus. Cada modelo ganha:
--   mapeamento.setpoints = o que a tela mostra (unidade de engenharia → registrador: × escala;
--                          faixa permitida; pré-requisitos)
--   mapeamento.bo_map    = o que o FIRMWARE escreve; value "$valor" = número do comando;
--                          min/max em unidades do REGISTRADOR (a TON recusa fora da faixa).
-- Fontes: Huawei "Solar Inverter Modbus Interface Definitions V3.0" (2023-01-17);
-- Sungrow "Communication Protocol of PV Grid-Connected String Inverters V1.1.66" (holding 4x,
-- endereço do manual − 1 = endereço no protocolo, igual à leitura); SOFAR Modbus User Guide 2023.
BEGIN;

-- ---------------------------------------------------------------- Huawei (SUN2000 / WEG SIW500H)
UPDATE iot_device_modelos
   SET mapeamento = mapeamento
     || jsonb_build_object('bo_map', COALESCE(mapeamento->'bo_map', '{}'::jsonb) || '{
          "sp_limite_pct": {"func": 6, "register": 40125, "value": "$valor", "min": 0,     "max": 1000},
          "sp_fp":         {"func": 6, "register": 40122, "value": "$valor", "min": -1000, "max": 1000},
          "sp_endereco":   {"func": 6, "register": 43019, "value": "$valor", "min": 1,     "max": 247}
        }'::jsonb)
     || jsonb_build_object('setpoints', '[
          {"id": "sp_limite_pct", "label": "Limite de potência ativa", "unidade": "%", "escala": 10, "min": 0, "max": 100, "padrao": 100,
           "obs": "40125 (% ×0,1). Exige \"Remote power scheduling\" (42014) habilitado no inversor."},
          {"id": "sp_fp", "label": "Fator de potência", "unidade": "", "escala": 1000, "faixas": [[-1, -0.8], [0.8, 1]], "padrao": 1,
           "obs": "40122 (×1000). Faixa do fabricante: −1…−0,8 e 0,8…1. Sinal: conferir no primeiro teste."},
          {"id": "sp_endereco", "label": "Endereço Modbus (RS485-1)", "unidade": "", "escala": 1, "min": 1, "max": 247, "avancado": true,
           "obs": "43019. O inversor passa a responder no endereço novo: atualize o diagrama IoT e regrave a TON. Não funciona se outro equipamento do barramento já usa o mesmo endereço."}
        ]'::jsonb),
       updated_at = now()
 WHERE (fabricante, modelo) IN (('Huawei','SUN2000-100KTL M1'), ('Huawei','SUN2000-75KTL M1'),
                                ('Huawei','SUN2000-100KTL M2'), ('WEG','SIW500H ST060'));

-- ---------------------------------------------------------------- Sungrow (CX / HX)
-- Manual → protocolo: 5006→5005 start/stop · 5007→5006 habilita limite · 5008→5007 limite %
--                     5036→5035 modo reativo · 5019→5018 FP · 5037→5036 Q %
UPDATE iot_device_modelos
   SET mapeamento = mapeamento
     || jsonb_build_object('bo_map', COALESCE(mapeamento->'bo_map', '{}'::jsonb) || '{
          "ligar":    {"func": 6, "register": 5005, "value": 207},
          "desligar": {"func": 6, "register": 5005, "value": 206},
          "sp_limite_pct": {"steps": [{"func": 6, "register": 5006, "value": 170}, {"func": 6, "register": 5007, "value": "$valor"}], "delay_ms": 100, "min": 0, "max": 1000},
          "sp_fp":         {"steps": [{"func": 6, "register": 5035, "value": 161}, {"func": 6, "register": 5018, "value": "$valor"}], "delay_ms": 100, "min": -1000, "max": 1000},
          "sp_q_pct":      {"steps": [{"func": 6, "register": 5035, "value": 162}, {"func": 6, "register": 5036, "value": "$valor"}], "delay_ms": 100, "min": -1000, "max": 1000}
        }'::jsonb)
     || jsonb_build_object('bo_outputs', '[
          {"id": "ligar",    "label": "Ligar (5006=0xCF · FC06)",    "func": 6, "register": 5005, "value": 207},
          {"id": "desligar", "label": "Desligar (5006=0xCE · FC06)", "func": 6, "register": 5005, "value": 206}
        ]'::jsonb)
     || jsonb_build_object('setpoints', '[
          {"id": "sp_limite_pct", "label": "Limite de potência ativa", "unidade": "%", "escala": 10, "min": 0, "max": 100, "padrao": 100,
           "obs": "5007=0xAA (habilita) + 5008 (% ×0,1)."},
          {"id": "sp_fp", "label": "Fator de potência", "unidade": "", "escala": 1000, "faixas": [[-1, -0.8], [0.8, 1]], "padrao": 1,
           "obs": "5036=0xA1 (modo FP) + 5019 (×0,001). Positivo = adiantado (capacitivo), negativo = atrasado (indutivo)."},
          {"id": "sp_q_pct", "label": "Reativo (% da nominal)", "unidade": "%", "escala": 10, "min": -100, "max": 100, "padrao": 0,
           "obs": "5036=0xA2 (modo Q%) + 5037 (% ×0,1). Ao usar, o FP fixo deixa de valer."}
        ]'::jsonb),
       updated_at = now()
 WHERE fabricante = 'Sungrow';

-- ---------------------------------------------------------------- SOFAR 1…40KTL (33000TL-G2)
-- Bloco 0x1040…0x104F (FC04 lê, FC 0x13 regrava inteiro): palavra 0 = modo de potência ativa
-- (1 = habilitado, exemplo do guia), palavra 1 = limite (% ×0,1; ex. 029E = 67,0 %).
-- FP/reativo (bloco 0x1060) fica de fora até confirmar modo e sinal em bancada.
UPDATE iot_device_modelos
   SET mapeamento = mapeamento
     || jsonb_build_object('bo_map', COALESCE(mapeamento->'bo_map', '{}'::jsonb) || '{
          "sp_limite_pct": {"steps": [{"func": 19, "start": 4160, "count": 16, "index": 0, "value": 1},
                                      {"func": 19, "start": 4160, "count": 16, "index": 1, "value": "$valor"}], "min": 0, "max": 1000}
        }'::jsonb)
     || jsonb_build_object('setpoints', '[
          {"id": "sp_limite_pct", "label": "Limite de potência ativa", "unidade": "%", "escala": 10, "min": 0, "max": 100, "padrao": 100,
           "obs": "Bloco 0x1040 (FC 0x13): 0x1040=1 (modo) + 0x1041 (% ×0,1). Validar em bancada."}
        ]'::jsonb),
       updated_at = now()
 WHERE fabricante = 'SOFAR' AND modelo = '33000TL-G2';
COMMIT;
