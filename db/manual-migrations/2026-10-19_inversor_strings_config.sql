-- Strings do inversor: ajuste manual de quais entradas estão em uso (sobrepõe a detecção
-- automática da ficha). modos = {"<n>": "usada" | "nao_usada"}; ausente = automático.
CREATE TABLE IF NOT EXISTS inversor_strings_config (
  equipamento_id char(26) PRIMARY KEY REFERENCES equipamentos(id) ON DELETE CASCADE,
  modos          jsonb    NOT NULL DEFAULT '{}'::jsonb,
  updated_at     timestamp NOT NULL DEFAULT now(),
  updated_by     char(26)
);
