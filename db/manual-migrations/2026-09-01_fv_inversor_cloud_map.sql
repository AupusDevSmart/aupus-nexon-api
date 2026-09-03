-- Mapa inversor (equipamento NexON) -> dispositivo na nuvem (Fusion/Huawei).
-- Só Fusion tem device-level acessível hoje (iSolar E900, Deye device/list=0).
-- Usado pelo fallback por-inversor: quando a TON fica obsoleta, o cron puxa o
-- getDevRealKpi do inversor mapeado e grava em equipamentos_dados (fonte NUVEM_FUSION).
CREATE TABLE IF NOT EXISTS public.fv_inversor_cloud_map (
  id              varchar(26)  PRIMARY KEY,
  equipamento_id  varchar(26)  NOT NULL,          -- equipamentos.id (cuid, TRIM ao juntar)
  unidade_id      varchar(36),
  provedor        varchar(30)  NOT NULL DEFAULT 'fusion_solar',
  plant_code      varchar(100) NOT NULL,          -- Fusion plantCode, ex: NE=33908464
  device_id       varchar(40)  NOT NULL,          -- Huawei devId (getDevRealKpi devIds)
  device_esn      varchar(60),                    -- ESN, ex: ES2320059162
  dev_type_id     integer      NOT NULL DEFAULT 1,-- 1 = string inverter
  device_name     varchar(120),
  ativo           boolean      NOT NULL DEFAULT true,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  updated_at      timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT uq_fv_inv_map_equip UNIQUE (equipamento_id)
);
CREATE INDEX IF NOT EXISTS ix_fv_inv_map_plant ON public.fv_inversor_cloud_map(plant_code) WHERE ativo;
