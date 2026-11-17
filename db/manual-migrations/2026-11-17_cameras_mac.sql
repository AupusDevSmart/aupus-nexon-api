-- NEXON-108 — Câmera segue o MAC quando o endereço muda (aparelho mudou de rede, DHCP deu outro IP).
-- cameras.mac: preenchido sozinho pela descoberta do agente (mesmo IP); quando o mesmo MAC aparece em
-- outro IP na rede do agente, a API troca cameras.ip e registra camera_ip_atualizado na auditoria.
-- Idempotente. Rollback:
--   ALTER TABLE cameras DROP COLUMN IF EXISTS mac;
BEGIN;

ALTER TABLE cameras ADD COLUMN IF NOT EXISTS mac varchar(17);

-- câmeras já cadastradas: MAC da última descoberta no mesmo IP do mesmo agente
UPDATE cameras c
   SET mac = d.mac
  FROM cameras_descobertas d
 WHERE c.mac IS NULL AND d.mac IS NOT NULL AND d.agente_id = c.agente_id AND d.ip = c.ip;

COMMIT;
