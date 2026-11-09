-- Encoder absoluto de posição do pivô (Hohner Série 67, Modbus RTU) — catálogo + nó do diagrama.
--
-- O que cria (idempotente):
--   1. família de dispositivo `encoder_posicao` (iot_device_tipos): 1 ponto AI `posicao` (contagem bruta);
--   2. modelo HOHNER "Série 67" (iot_device_modelos): FC03, 2 registradores, palavra baixa primeiro;
--   3. tipo de equipamento ENCODER (tipos_equipamentos) = nó "Encoder" na paleta do diagrama IoT,
--      categoria Pivô, só IoT (não aparece no unifilar).
--
-- Datasheet (Série 67): RS485 não isolada, RTU, função 03. "Registro 01H" = 16 bits baixos,
-- "02H" = bits altos. Pela convenção do catálogo (endereço do manual − 1, como o Sungrow 5000 → 4999)
-- o bloco começa em 0. Se na bancada a posição vier errada (sempre 0, ou saltando de 65536 em 65536),
-- trocar ai_blocks[0].start para 1 neste modelo (tela do catálogo ou UPDATE).
-- Velocidade 9600 ou 19200 e paridade (nenhuma ou ímpar) vêm do código de compra: o barramento RS485
-- da TON tem de estar igual. Endereço 1 a 7 por jumper no conector (ou fixo de fábrica).
BEGIN;

INSERT INTO iot_device_tipos (id, codigo, nome, pontos)
VALUES ('iot_tipo_encoder_posicao__', 'encoder_posicao', 'Encoder de Posição',
  '{"ai": [{"id": "posicao", "json": "posicao", "unit": "", "label": "Posição (contagem bruta)"}],
    "bi": [], "bo": [],
    "publish": {"meta_fields": ["samples"], "timestamp_format": "epoch", "timestamp_position": "first"}}'::jsonb)
ON CONFLICT (codigo) DO UPDATE SET nome = EXCLUDED.nome, pontos = EXCLUDED.pontos, updated_at = now();

INSERT INTO iot_device_modelos (id, tipo_id, fabricante, modelo, protocolo, connection_note, mapeamento)
SELECT 'iot_mod_hohner_serie67____', t.id, 'HOHNER', 'Série 67', 'rtu',
  'Encoder absoluto 24 Vdc. RS485 RTU 9600/19200 8N1 (ou 8O1, conforme o código de compra). FC03 reg 01H (baixo) + 02H (alto). Endereço 1–7 por jumper. Fios: preto 0 V, vermelho +24 V, azul RS485−, branco RS485+.',
  '{"catalog_id": "hohner-serie67",
    "ai_blocks": [{"func": 3, "start": 0, "count": 2, "label": "Posição: registros 01H (16 bits baixos) e 02H (altos)"}],
    "ai_map": {"posicao": {"block": 0, "offset": 0, "dataType": "U32", "mode": "last", "scale": 1}},
    "word_order": "low_first"}'::jsonb
FROM iot_device_tipos t WHERE t.codigo = 'encoder_posicao'
ON CONFLICT (fabricante, modelo) DO UPDATE SET
  tipo_id = EXCLUDED.tipo_id, protocolo = EXCLUDED.protocolo, connection_note = EXCLUDED.connection_note,
  mapeamento = EXCLUDED.mapeamento, updated_at = now();

INSERT INTO tipos_equipamentos (id, codigo, nome, largura_padrao, altura_padrao, categoria_id, fabricante, sigla,
                                disp_unifilar, disp_iot, device_tipo_id, propriedades_schema, created_at, updated_at)
SELECT '01JAQTE1ENCODER00000000041', 'ENCODER', 'Encoder de Posição', 32, 32, c.id, 'Genérico', 'ENC',
  false, true, 'iot_tipo_encoder_posicao__',
  '{"palette_key": "encoder", "label": "Encoder", "category": "irrigacao", "color": "#0EA5E9",
    "icon": "M12 3a9 9 0 100 18 9 9 0 000-18zm0 3v6l4 2",
    "ports": ["top", "bottom", "left", "right"], "generates_firmware": false,
    "conn": {"role": "device", "hint": "Encoder conecta a: TON, Conversor ou outro dispositivo (RS485)",
             "targets": ["ton", "conversor", "inversor", "power_meter", "rele_protecao", "encoder"]},
    "defaults": {"name": "Encoder", "catalog_id": "", "modbus_address": 1},
    "fields": [{"key": "name", "type": "text", "label": "Nome"},
               {"key": "catalog_id", "type": "device_select", "label": "Modelo", "device_type": "encoder_posicao"},
               {"key": "modbus_address", "type": "number", "label": "Endereço Modbus (1 a 7, jumper no conector)"}]}'::jsonb,
  now(), now()
FROM categorias_equipamentos c WHERE c.id = 'c5be08ecc2304fcd8a9bbb2fee'   -- categoria Pivô
ON CONFLICT (codigo) DO UPDATE SET
  nome = EXCLUDED.nome, disp_unifilar = false, disp_iot = true, device_tipo_id = EXCLUDED.device_tipo_id,
  propriedades_schema = EXCLUDED.propriedades_schema, updated_at = now();

-- Conferência: 3 linhas
SELECT 'familia' AS o_que, codigo AS valor FROM iot_device_tipos WHERE codigo = 'encoder_posicao'
UNION ALL SELECT 'modelo', fabricante || ' ' || modelo FROM iot_device_modelos WHERE id = 'iot_mod_hohner_serie67____'
UNION ALL SELECT 'no do diagrama', codigo FROM tipos_equipamentos WHERE id = '01JAQTE1ENCODER00000000041';

COMMIT;
