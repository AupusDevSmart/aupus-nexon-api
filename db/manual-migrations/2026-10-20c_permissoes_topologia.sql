-- NEXON-22: a aba IoT do sinóptico passou a se chamar Topologia.
-- Só os rótulos mudam; o name da permissão (chave usada no código) continua igual.
BEGIN;
UPDATE permissions
   SET display_name = 'Ver Topologia de Comunicação',
       description  = 'Visualizar a aba Topologia (topologia de comunicação) no sinóptico do ativo (restrito a admin e super_admin)',
       updated_at   = now()
 WHERE name = 'supervisorio.iot_view';
UPDATE permissions
   SET display_name = 'Acessar Drivers de Equipamento',
       description  = 'Acessar o cadastro de Drivers de Equipamento (tipos e modelos de dispositivos de campo) - restrito a admin e super_admin',
       updated_at   = now()
 WHERE name = 'equipamentos.iot_catalog';
COMMIT;
