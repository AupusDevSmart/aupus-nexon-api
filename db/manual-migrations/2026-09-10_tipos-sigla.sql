-- Fase: Simplificação do cadastro (Parte 1) — sigla por TIPO pra semear a TAG.
-- A TAG passa a nascer da sigla do tipo (DISJUNTOR -> DJ -> DJ-01, DJ-02...),
-- em vez de derivada do nome livre. Coluna SQL-crua (fora do schema Prisma;
-- lida via $queryRaw, seguindo o padrão de disp_iot/device_tipo_id).
-- Reversível: ALTER TABLE tipos_equipamentos DROP COLUMN sigla;

ALTER TABLE tipos_equipamentos ADD COLUMN IF NOT EXISTS sigla varchar(12);

UPDATE tipos_equipamentos SET sigla = CASE codigo
  WHEN 'IMS_A966'            THEN 'A966'
  WHEN 'CAPACITOR'           THEN 'BC'
  WHEN 'BOMBA_COMBUSTIVEL'   THEN 'BOMB'
  WHEN 'BROKER_MQTT'         THEN 'BRK'
  WHEN 'CARREGADOR_ELETRICO' THEN 'CAR'
  WHEN 'CHAVE_FUSIVEL'       THEN 'CH'
  WHEN 'CONVERSOR'           THEN 'CONV'
  WHEN 'DATALOGGER'          THEN 'DL'
  WHEN 'DISJUNTOR'           THEN 'DJ'
  WHEN 'INVERSOR'            THEN 'INV'
  WHEN 'EQTL001'             THEN 'MED'
  WHEN 'MOTOR'               THEN 'MOT'
  WHEN 'PAINEL_SOLAR'        THEN 'MOD'
  WHEN 'PIVO'                THEN 'PIV'
  WHEN 'METER_M160'          THEN 'PM'
  WHEN 'RELE'                THEN 'REL'
  WHEN 'ROTEADOR'            THEN 'RT'
  WHEN 'TON1'                THEN 'TON'
  WHEN 'TRANSFORMADOR'       THEN 'TR'
  ELSE sigla END;
