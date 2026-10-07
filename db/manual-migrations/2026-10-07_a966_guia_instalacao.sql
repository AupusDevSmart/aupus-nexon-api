-- 2026-10-07 — nó "Meter Gateway A966" do editor IoT vira GUIA DE INSTALAÇÃO (não gera firmware).
-- Campos com tudo que se digita na interface web do A966 (AP 192.168.4.1, IMS/IMS). O tópico que o
-- A966 publica é <Tópico>/<ID SSU>/state → o editor monta <base>/A966 + ID "SSU" (igual à Aupus II:
-- …/A966/SSU/state) e o backend grava esse tópico no Medidor Concessionária ligado ao A966.
BEGIN;
UPDATE tipos_equipamentos
   SET propriedades_schema = propriedades_schema
     || jsonb_build_object('fields', '[
          {"key": "name", "type": "text", "label": "Nome", "section": "Identificação"},
          {"key": "mqtt_topic_base", "type": "text", "label": "Tópico base da instalação", "wide": true, "placeholder": "PROPRIETARIO/ESTADO/PLANTA/INSTALACAO", "section": "MQTT"},
          {"key": "ssu_id", "type": "text", "label": "ID da SSU (no A966)", "placeholder": "SSU"},
          {"key": "mqtt_usuario", "type": "text", "label": "Usuário MQTT", "placeholder": "aupus"},
          {"key": "mqtt_senha", "type": "text", "label": "Senha MQTT"},
          {"key": "client_id", "type": "text", "label": "ID Cliente MQTT (vazio = automático)", "placeholder": "automático"},
          {"key": "wifi_ssid", "type": "text", "label": "Wi-Fi do local — SSID (vazio = roteador do projeto)", "section": "Rede"},
          {"key": "wifi_senha", "type": "text", "label": "Wi-Fi do local — senha"},
          {"key": "ip_modo", "type": "select", "label": "Endereço IP", "options": [["dhcp", "DHCP (automático)"], ["estatico", "IP fixo"]]},
          {"key": "ip", "type": "text", "label": "IP fixo", "placeholder": "192.168.1.104"},
          {"key": "mascara", "type": "text", "label": "Máscara", "placeholder": "255.255.255.0"},
          {"key": "gateway", "type": "text", "label": "Gateway", "placeholder": "192.168.1.1"},
          {"key": "note", "type": "text", "label": "Observação", "wide": true, "section": "Outros"}
        ]'::jsonb,
        'defaults', '{"name": "A966", "mqtt_topic_base": "", "ssu_id": "SSU", "mqtt_usuario": "aupus", "mqtt_senha": "", "client_id": "", "wifi_ssid": "", "wifi_senha": "", "ip_modo": "dhcp", "ip": "", "mascara": "255.255.255.0", "gateway": "", "note": ""}'::jsonb),
       updated_at = now()
 WHERE codigo = 'IMS_A966';
COMMIT;
