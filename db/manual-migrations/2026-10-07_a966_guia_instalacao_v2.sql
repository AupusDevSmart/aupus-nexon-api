-- 2026-10-07 (v2) — nó A966: o formulário também ENSINA (hint por campo). Broker Aupus é padrão
-- (72.60.158.163:1883, aceita conexão sem login) → sai usuário/senha MQTT dos campos. IP fixo é
-- o padrão (com instrução de escolher um livre). Ordem = ordem das telas do A966.
BEGIN;
UPDATE tipos_equipamentos
   SET propriedades_schema = propriedades_schema
     || jsonb_build_object('fields', '[
          {"key": "name", "type": "text", "label": "TAG", "section": "Identificação"},
          {"key": "wifi_ssid", "type": "text", "label": "Wi-Fi do local — nome (SSID)", "section": "Rede do local (A966 → aba Rede → Wi-Fi)",
           "hint": "A rede onde o A966 vai ficar. Vazio = usa o Roteador Wi-Fi deste projeto. Precisa ser 2,4 GHz."},
          {"key": "wifi_senha", "type": "text", "label": "Wi-Fi do local — senha", "hint": "Senha dessa rede."},
          {"key": "ip_modo", "type": "select", "label": "Endereço IP (aba Rede → IP)", "options": [["estatico", "IP fixo (recomendado)"], ["dhcp", "DHCP (automático)"]],
           "hint": "IP fixo: no A966 deixe DHCP DESLIGADO e preencha IP, máscara e gateway abaixo."},
          {"key": "ip", "type": "text", "label": "IP fixo", "placeholder": "192.168.1.104",
           "hint": "Escolha um IP LIVRE na mesma faixa do gateway (ex.: gateway 192.168.1.1 → 192.168.1.x). Use um número fora da faixa DHCP do roteador e confira que ninguém usa: na lista de dispositivos do roteador ou com ping (sem resposta = livre)."},
          {"key": "mascara", "type": "text", "label": "Máscara", "placeholder": "255.255.255.0", "hint": "Quase sempre 255.255.255.0 (igual à do roteador)."},
          {"key": "gateway", "type": "text", "label": "Gateway", "placeholder": "192.168.1.1", "hint": "IP do roteador do local (no celular conectado nessa rede: detalhes do Wi-Fi → Roteador/Gateway)."},
          {"key": "mqtt_topic_base", "type": "text", "label": "Tópico base da instalação", "wide": true, "placeholder": "PROPRIETARIO/ESTADO/PLANTA/INSTALACAO", "section": "MQTT (A966 → aba Rede → MQTT)",
           "hint": "Mesmo padrão das TONs. No A966, o campo Tópico recebe esta base + /A966 (o guia abaixo mostra pronto)."},
          {"key": "ssu_id", "type": "text", "label": "ID da SSU (aba Interfaces → SSU)", "placeholder": "SSU", "hint": "Deixe SSU. O A966 publica em <Tópico>/<ID>/state — outro ID muda o tópico."},
          {"key": "client_id", "type": "text", "label": "ID Cliente MQTT (vazio = automático)", "placeholder": "automático",
           "hint": "Tem de ser único no broker: dois aparelhos com o mesmo ID (ex.: o \"ClientID\" de fábrica) se derrubam."},
          {"key": "note", "type": "text", "label": "Observação", "wide": true, "section": "Outros", "hint": "Ex.: nova senha de acesso do A966, se trocada."}
        ]'::jsonb,
        'defaults', '{"name": "A966", "wifi_ssid": "", "wifi_senha": "", "ip_modo": "estatico", "ip": "", "mascara": "255.255.255.0", "gateway": "", "mqtt_topic_base": "", "ssu_id": "SSU", "client_id": "", "note": ""}'::jsonb),
       updated_at = now()
 WHERE codigo = 'IMS_A966';
COMMIT;
