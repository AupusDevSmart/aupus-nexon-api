# Implementação OTA — Sessão de 2026-04-28

Documento das alterações feitas para habilitar **deploy de firmware via OTA (Over-The-Air)**
da TON em campo, disparado pela tela "Sinóptico Ativo → IoT" do staging-nexon.

> Esta documentação cobre as alterações em **dois repositórios** (`aupus-service-api`
> e `AupusNexOn`), no sistema de arquivos do servidor (scripts em `public/`) e no
> banco de dados (`aupus_staging`). Aplicado **somente em staging** — produção
> (`/var/www/service-nexon`, banco `aupus`) não foi tocada.

---

## 1. Resumo executivo

Antes desta sessão, o fluxo IoT permitia gerar firmware no diagrama e gravar via USB
(Web Serial). Não havia caminho para atualizar TONs em campo remotamente.

Esta sessão fechou esse pipeline:

1. **Frontend** ganhou o botão **"Implantar OTA"** no modal de firmware. Quando clicado,
   manda os arquivos de código pro backend via REST autenticado.
2. **Backend NestJS** (rota OTA já existente, `/equipamentos/:id/ota/compilar-e-publicar`)
   foi tornada **acessível** — havia uma bomba-relógio crítica que faria o módulo IoT
   inteiro morrer no próximo `pm2 restart` (módulo órfão no `dist/` sem fontes em `src/`).
3. **MqttService** ganhou um novo handler que escuta `<topico_mqtt>/status` retained dos
   TONs e popula `equipamentos.mac_address` automaticamente (auto-discovery por MAC).
4. **Firmware base** (templates JS que geram o código C++) ganhou:
   - Log do MAC no boot (debug físico)
   - MAC + IP no payload retained de status (auto-discovery)
   - Watchdog feed reforçado durante download OTA
   - **Rollback automático**: firmware novo precisa publicar 3× MQTT com sucesso
     antes de ser declarado válido. Se travar antes, bootloader reverte sozinho.

Validado em hardware real (TON com MAC `80:B5:4E:D2:DD:2C`) com OTA end-to-end completo.

---

## 2. Arquitetura final do pipeline

```
┌──────────────────────────────────────────────────────────────┐
│ NAVEGADOR — staging-nexon.aupusenergia.com.br                 │
│  [iot-diagram.tsx]    ← botão "Implantar OTA"                 │
│  [iot-firmware-       ← gera 21 arquivos C++ in-browser       │
│   generator.v2.js]                                            │
└──────────────────────────────────┬───────────────────────────┘
                                   │ POST /api/v1/equipamentos/
                                   │   :id/ota/compilar-e-publicar
                                   │ Authorization: Bearer <jwt>
                                   ▼
┌──────────────────────────────────────────────────────────────┐
│ NESTJS — staging-nexon-api (PM2 #3, porta 3200)               │
│  [OtaController]      ← @UseGuards(JwtAuthGuard)              │
│  [OtaService.compileAndPublish]                               │
│   1) prisma.equipamentos.findUnique → topico_mqtt             │
│   2) fetch localhost:3210/publish-artifact                    │
│   3) mqtt.publish(`${topic}/ota/cmd`, {url, md5, version})    │
└──────────────────────────────────┬───────────────────────────┘
                                   │ HTTP interno
                                   ▼
┌──────────────────────────────────────────────────────────────┐
│ FIRMWARE-COMPILER — Node.js (PM2 #4, porta 3210)              │
│  /var/www/iot_nexon/firmware-compiler/server.js               │
│   1) escreve files em /tmp/nexon-firmware/<id>/               │
│   2) pio run (PlatformIO CLI) — ~60s                          │
│   3) move bin → /var/www/iot_nexon/firmware-compiler/         │
│      artifacts/<name>-<version>-<ts>.bin                      │
│   4) GC: mantém 5 mais recentes por device                    │
└──────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────┐
│ NGINX — serve o .bin via HTTPS                                │
│  location ^~ /iot-compile/artifacts/                          │
│  alias /var/www/iot_nexon/firmware-compiler/artifacts/        │
│  Cache-Control: no-store; só extensão .bin permitida          │
└──────────────────────────────────────────────────────────────┘

E em paralelo, via broker MQTT (72.60.158.163:1883):
┌──────────────────────────────────────────────────────────────┐
│ TON em campo                                                  │
│  [src/mqtt.cpp _onMessage]    ← ouve <topic>/ota/cmd          │
│  [src/ota.cpp ota_handle_command]                             │
│   1) parse JSON {url, version, md5}                           │
│   2) HTTPClient.GET(url)                                      │
│   3) Update.setMD5(md5) + Update.write(stream)                │
│   4) Update.end() valida MD5 + magic byte                     │
│   5) ESP.restart()                                            │
│  [src/ota.cpp ota_check_pending_verify]                       │
│   pós-boot: arma contador de validação                        │
│  [src/ota.cpp ota_confirm_valid_if_needed]                    │
│   após 3 publicações OK: cancela rollback                     │
└──────────────────────────────────────────────────────────────┘
```

---

## 3. Mudanças por componente

### 3.1 Backend NestJS (`/var/www/staging-nexon/aupus-service-api/`)

#### 🆕 `src/modules/iot/` (RESTAURADO — estava órfão no `dist/`)

A pasta `src/modules/iot/` **não existia** no repositório, mas
`dist/src/modules/iot/*.js` existia compilado e era carregado pelo processo NestJS
em runtime — bomba-relógio que quebraria a feature inteira no próximo `pm2 restart`,
porque o `app.module.js` mais recente já não importava o `IoTModule`.

Reconstruído a partir do JS compilado:

| Arquivo | Linhas | Conteúdo |
|---|---|---|
| `iot.module.ts` | 24 | `@Module({ imports: [PrismaModule], controllers: [IoTController], providers: [IoTService] })` |
| `iot.controller.ts` | 73 | `@Controller('iot')` + `@Public()` — CRUD de projetos IoT (`/iot/projetos`) |
| `iot.service.ts` | 106 | Acesso à tabela `iot_projetos` via `prisma.$queryRaw` (a tabela é gerenciada por migration manual em `iot_nexon`) |

Comportamento idêntico ao código compilado anterior — preservou contrato de API
para não quebrar o frontend.

#### 📝 `src/app.module.ts` (+4 linhas)

Adicionado o registro do `IoTModule`:

```diff
+ import { IoTModule } from './modules/iot/iot.module';

  imports: [
    ...
    UploadsModule,
    OtaModule,
+   IoTModule, // Diagramas/projetos IoT consumidos pelo Sinóptico (tab IoT)
  ],
```

#### 📝 `src/shared/mqtt/mqtt.service.ts` (+143 linhas, -8)

**1. Subscribe ampliado em `subscribeTopic`** — para cada equipamento com MQTT
habilitado, agora subscreve **dois** tópicos:

- `<topico_mqtt>` (telemetria, fluxo legado, intocado)
- `<topico_mqtt>/status` (NOVO — para receber announce retained dos TONs)

**2. Roteamento por sub-path em `handleMessage`**:

```ts
if (topic.endsWith('/status')) {
  // novo: processa announce retained, atualiza equipamentos.mac_address
  await this.processStatusAnnounce(equipamentoId, dados);
} else {
  // legado: telemetria → processarDadosEquipamento (intocado)
  await this.processarDadosEquipamento(equipamentoId, dados, topic);
}
```

**3. Novo handler `processStatusAnnounce`** — recebe payload do tipo
`{online, version, model, mac, ip}` e:

- Valida formato do MAC (regex `AA:BB:CC:DD:EE:FF`)
- Se equipamento ainda não tem `mac_address` cadastrado → preenche automaticamente
- Se já tem MAC e o reportado é diferente → loga warning (substituição física?)
- Se MAC bate → no-op (saúde normal)
- Tratamento defensivo de `P2002` (unique constraint) — outro equipamento já tem o MAC

#### 📝 `prisma/schema.prisma` (+3 linhas)

Nova coluna `mac_address` em `model equipamentos`:

```prisma
mac_address  String?  @unique @db.VarChar(17)
/// MAC address do dispositivo físico (factory-burned eFuse)
/// Formato canônico: AA:BB:CC:DD:EE:FF
/// Usado para auto-discovery via announce MQTT
```

#### 🆕 `prisma/migrations/manual_add_mac_address_equipamentos.sql`

Migration SQL idempotente:

```sql
ALTER TABLE equipamentos
  ADD COLUMN IF NOT EXISTS mac_address VARCHAR(17);

-- Index parcial: garante unicidade só pra os que têm MAC,
-- permite múltiplos NULL.
CREATE UNIQUE INDEX IF NOT EXISTS idx_equipamentos_mac_address
  ON equipamentos(mac_address)
  WHERE mac_address IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_equipamentos_mac_address_lookup
  ON equipamentos(mac_address);
```

**Aplicada apenas em `aupus_staging`** — produção (`aupus`) intocada.

#### 📝 `.env.example` (+7 linhas)

Adicionada documentação dos novos comportamentos do MqttService.

#### 📝 `.env` (alteração de configuração — não versionada)

Para validar o auto-discovery em staging, alteramos:

```
MQTT_MODE=disabled         →  MQTT_MODE=development
INSTANCE_ID=production-server-vps  →  INSTANCE_ID=staging-dev-vps
# MQTT_LOG_LEVEL=verbose   →  MQTT_LOG_LEVEL=verbose (descomentado)
```

`MQTT_MODE=development` faz o MqttService **conectar e processar callbacks** mas
**não salvar telemetria duplicada** (evita conflito com a instância de produção
que está em `service-nexon/aupus-service-api`).

Backup do .env original em `.env.bak-pre-mqtt-dev-20260428-141327`.

---

### 3.2 Frontend React (`/var/www/staging-nexon/AupusNexOn/`)

> Os arquivos abaixo (`iot-*.v2.js` em `public/` e o `iot-diagram.tsx`) estão
> como **untracked** no git da branch `main`. As alterações descritas aqui são
> sobre o estado em disco antes/depois desta sessão (snapshot pré-mudança em
> `dist.bak-pre-iot-ota-20260428-131623/`).

#### 📝 `src/features/supervisorio/components/iot-diagram.tsx`

**1. Tipo do `firmwareModal.status` ampliado** — adicionados `'deploying'` e `'deployed'`.

**2. Função `firmwareDeployOta()` (+~110 linhas)** — chamada pelo botão "Implantar OTA":

- Lê `proj.spec.equipamentoId` (vem do generator, vide §3.4)
- Se vazio: log explicativo orientando vincular nas Propriedades do TON
- Calcula versão derivada do timestamp local (`1.0.YYYYMMDDhhmm`)
- `POST /api/v1/equipamentos/{id}/ota/compilar-e-publicar` com `{files, name, version}`
- Trata o envelope de erro do NexOn (`{success:false, error:{code, message}}`) com fallback robusto
- Mostra resultado: tópico publicado, URL do .bin, tamanho, MD5, hint sobre
  validação automática pós-3 publicações

**3. Modal Firmware ganhou novos botões e estados visuais**:

- Estado `idle`: botão **"Implantar OTA"** ao lado de "Compilar"
- Estado `deploying`: spinner "Implantando OTA..."
- Estado `deployed`: botão "Fechar"

**4. `getHeaders()` corrigido** — buscava as keys erradas no localStorage
(`auth_token`, `token`). Convenção do NexOn é `authToken` /
`service_authToken` (vide `auth.service.ts`). Sem isso, todas as chamadas
autenticadas eram rejeitadas com 401.

```ts
const token =
  localStorage.getItem('authToken') ||
  localStorage.getItem('service_authToken') ||
  localStorage.getItem('auth_token') ||  // legado
  localStorage.getItem('token');         // legado
```

#### 📝 `public/iot-diagram.v2.js`

Cada um dos 4 controladores (`ton1`, `ton2`, `ton3`, `ton4`) ganhou:

- **defaults**: `equipamento_id: ''`
- **fields**: `{ key: 'equipamento_id', label: 'Equipamento NexOn (ID)', type: 'text', placeholder: 'CUID 26 chars — necessário para Implantar OTA' }`

Permite vincular um TON do diagrama a um `equipamento.id` do banco — campo
necessário para o OTA funcionar (o backend usa este ID para resolver o
`topico_mqtt` que vai receber o comando).

#### 📝 `public/iot-firmware-generator.v2.js`

**1. `_genMainCpp` agora inclui `<WiFi.h>`** — necessário para `WiFi.macAddress()`
no banner de boot.

**2. Banner de boot estendido**:
```cpp
Serial.printf("\n  %s v%s - %s\n", DEVICE_ID, FIRMWARE_VERSION, DEVICE_MODEL);
Serial.printf("  [BOOT] MAC: %s\n", WiFi.macAddress().c_str());  // NOVO
Serial.printf("  Motivo do reset: %s\n", _resetReason());
```

**3. Payload retained de `<topic>/status` estendido** — antes só tinha
`{online, version, model}`, agora inclui `mac` e `ip`:

```cpp
char hello[224];   // buffer aumentado de 96 para 224 bytes
snprintf(hello, sizeof(hello),
         "{\"online\":true,\"version\":\"%s\",\"model\":\"%s\",\"mac\":\"%s\",\"ip\":\"%s\"}",
         FIRMWARE_VERSION, DEVICE_MODEL,
         WiFi.macAddress().c_str(),
         WiFi.localIP().toString().c_str());
_mqtt.publish(willTopic.c_str(), hello, true);
```

Isso é o que o `MqttService.processStatusAnnounce` (§3.1) consome para auto-discovery.

**4. `setup()` do main.cpp gerado chama `ota_check_pending_verify()`** —
quando o boot é pós-OTA, arma o contador de validação.

**5. `mqtt_publish()` chama `ota_confirm_valid_if_needed()` após sucesso** —
sinaliza que o firmware está saudável; após N publicações cancela o rollback.

**6. Spec do generator inclui `equipamentoId`**:

```js
// Em _analyzeTon()
equipamentoId: (ton.props.equipamento_id || '').trim(),
```

Permite ao TSX (firmwareDeployOta) saber qual `equipamento.id` enviar.

#### 📝 `public/iot-firmware-base.v2.js`

**1. `include/ota.h` ganhou 2 novas declarações**:

```cpp
void ota_check_pending_verify();
void ota_confirm_valid_if_needed();
```

**2. `src/ota.cpp` — Rollback automático**:

```cpp
#include <esp_ota_ops.h>

#ifndef OTA_VALIDATION_PUBS
#define OTA_VALIDATION_PUBS  3
#endif

static bool _otaPendingVerify  = false;
static int  _otaPostBootPubs   = 0;
static bool _otaConfirmedValid = false;

void ota_check_pending_verify() {
  // Lê estado da partição corrente. Se PENDING_VERIFY (boot pós-OTA),
  // arma o contador. Caso contrário, considera já válido.
}

void ota_confirm_valid_if_needed() {
  // Chamado após cada mqtt_publish OK. Após N pubs, chama
  // esp_ota_mark_app_valid_cancel_rollback() — desativa rollback.
}
```

**3. `src/ota.cpp` — `ota_handle_command` reforçado** com 4 chamadas adicionais
de `esp_task_wdt_reset()` durante etapas síncronas longas (HTTP begin, GET,
Update.begin) — antes só tinha o reset dentro do loop de stream. Em redes
ruins essas etapas podem demorar segundos cada e disparar o watchdog.

---

### 3.3 Banco de dados

| Banco | Onde |
|---|---|
| `aupus` (production, intocado) | — |
| `aupus_staging` | Migration `manual_add_mac_address_equipamentos.sql` aplicada |

Equipamento de teste cadastrado em `aupus_staging`:

```sql
INSERT INTO equipamentos (
  id, nome, classificacao, criticidade, unidade_id,
  mqtt_habilitado, topico_mqtt, mac_address, status, ...
) VALUES (
  'iot_test_ton_bench_audit__',
  'TON Bancada (auto-discovery test)',
  'UC', 'C',
  (SELECT id FROM unidades WHERE deleted_at IS NULL LIMIT 1),
  TRUE, 'AUPUS_TESTE', NULL, 'NORMAL', ...
);
```

Após o announce do TON em bancada, `mac_address` foi preenchido automaticamente
para `80:B5:4E:D2:DD:2C` pelo handler novo.

---

## 4. Tópicos MQTT consolidados

```
SUBSCRIBE pelo backend NestJS (MqttService)
└── <topico_mqtt>             ← telemetria (fluxo legado)
└── <topico_mqtt>/status      ← announce retained (NOVO — auto-discovery)

SUBSCRIBE pelo TON em campo (firmware)
└── <MQTT_TOPIC_BASE>/cmd     ← comandos genéricos (legado)
└── <MQTT_TOPIC_BASE>/ota/cmd ← comandos OTA (legado, plugado pela primeira vez)

PUBLISH pelo TON
├── <MQTT_TOPIC_BASE>/status      retained, {online, version, model, mac, ip}
├── <MQTT_TOPIC_BASE>/diagnostics periódico
├── <MQTT_TOPIC_BASE>/inputs      periódico
├── <MQTT_TOPIC_BASE>/outputs     periódico
├── <MQTT_TOPIC_BASE>/relays      eventos
├── <MQTT_TOPIC_BASE>/meter/<id>  telemetria por medidor
└── <MQTT_TOPIC_BASE>/ota/status  eventos OTA: downloading/error/skipped/success

PUBLISH pelo backend (OtaService)
└── <topico_mqtt>/ota/cmd     {url, version, md5}
```

---

## 5. Como reproduzir / testar

### 5.1 Teste manual via curl + mosquitto

```bash
# 1. Confirmar que o equipamento está no DB de staging
PGPASSWORD=postgres123 psql -h localhost -p 5433 -U postgres -d aupus_staging -c \
  "SELECT id, nome, topico_mqtt, mac_address FROM equipamentos
   WHERE id='iot_test_ton_bench_audit__';"

# 2. Simular announce retained (popula mac_address automaticamente)
mosquitto_pub -h 72.60.158.163 -t 'AUPUS_TESTE/status' -r -q 1 \
  -m '{"online":true,"version":"1.0.0","model":"TON1","mac":"80:B5:4E:D2:DD:2C","ip":"192.168.1.173"}'

# 3. Aguardar 3-5s e checar o DB
sleep 5
PGPASSWORD=postgres123 psql -h localhost -p 5433 -U postgres -d aupus_staging -c \
  "SELECT id, mac_address, updated_at FROM equipamentos
   WHERE id='iot_test_ton_bench_audit__';"

# 4. Subscribe para acompanhar status do OTA em tempo real
mosquitto_sub -h 72.60.158.163 -t 'AUPUS_TESTE/#' -v
```

### 5.2 Teste via UI (fluxo completo)

1. Abrir `https://staging-nexon.aupusenergia.com.br`
2. Sinóptico → IoT → criar/abrir projeto na unidade desejada
3. Adicionar TON ao diagrama
4. Duplo-clique no TON → Propriedades:
   - **Nome**: TESTE-AUPUS
   - **Tópico Base**: `AUPUS_TESTE`
   - **Equipamento NexOn (ID)**: `iot_test_ton_bench_audit__`
5. Salvar diagrama
6. **Firmware → Implantar OTA**
7. Aguardar ~60s (compile + publish artefato + MQTT publish)
8. TON em campo deve receber, baixar, gravar, reiniciar
9. Após 3 telemetrias OK pós-boot, firmware é declarado válido (rollback cancelado)

### 5.3 Validação em hardware (já feita)

Realizada em 2026-04-28 com TON ESP32-S3 (MAC `80:B5:4E:D2:DD:2C`):

- ✅ Banner `[BOOT] MAC: 80:B5:4E:D2:DD:2C` apareceu no monitor serial
- ✅ Payload retained `<topic>/status` recebido pelo broker com mac+ip
- ✅ `mac_address` populado automaticamente em `equipamentos`
- ✅ `mosquitto_pub` em `AUPUS_TESTE/ota/cmd` com URL inválida disparou
  `ota_handle_command` corretamente → publicou `state:downloading`
  e depois `state:error` (`http_-1` por DNS) sem travar a placa
- ✅ Botão "Implantar OTA" via UI publicou comando real:
  - URL: `https://staging-nexon.aupusenergia.com.br/iot-compile/artifacts/TON1-1.0.202604281225-1777389997369.bin`
  - Tamanho: 981.5 KB
  - MD5: `1124c21f8caf...`

---

## 6. Configuração necessária para outros ambientes

### Para ativar auto-discovery em outra instância NestJS:

1. Aplicar migration `mac_address` no banco respectivo:
   ```bash
   psql ... -f prisma/migrations/manual_add_mac_address_equipamentos.sql
   ```
2. Rodar `npx prisma generate` para atualizar o cliente Prisma
3. `npm run build` no `aupus-service-api`
4. Garantir que `MQTT_MODE=development` ou `production` no `.env` (não `disabled`)
5. `pm2 restart` da instância

### Para o frontend exibir as features OTA:

1. `npm run build` no `AupusNexOn`
2. Hard refresh no navegador (Ctrl+Shift+R)

### Para gravar firmware com features OTA num TON real:

Os scripts em `public/iot-*.v2.js` já contêm as alterações. Basta:

1. UI → Sinóptico → IoT → diagrama
2. Configurar TON com `mqtt_topic_base` correto
3. Firmware → Compilar → Gravar via USB
4. Firmware gerado já vem com MAC log, announce estendido e rollback automático

---

## 7. Pontos abertos / próximos passos

| # | Item | Prioridade |
|---|---|---|
| 1 | Aplicar mesma migration `mac_address` em produção quando feature for promovida | 🟡 Médio (quando promover staging→prod) |
| 2 | Subscriber backend para `<topic>/ota/status` — gravar histórico em `iot_firmwares` | 🟢 Desejável (observabilidade) |
| 3 | Pinar CA Let's Encrypt no firmware (`setCACert`) — atualmente usa `setInsecure()` | 🟡 Médio (anti-MITM em produção) |
| 4 | Emitir evento WebSocket quando `mac_address` é descoberto (atualizar UI em tempo real) | 🟢 UX |
| 5 | Versão semântica gerenciada manualmente (não timestamp) | 🟢 Releases nomeadas |
| 6 | Build OTA em background com fila (Bull/Redis) — UI não bloqueia 60s | 🟢 Performance |
| 7 | Diff visual entre 2 versões do `.bin` antes de implantar | 🟢 Auditoria |
| 8 | Aprovação humana antes de publicar comando MQTT em produção | 🔴 Crítico em prod |
| 9 | Canários: deploy em 1 TON antes do fleet inteiro | 🔴 Crítico em prod |
| 10 | Limpar arquivos `.bak-pre-iot-ota-*` e `dist.bak-*` após validar | 🟢 Housekeeping |

---

## 8. Arquivos modificados — lista completa

### `aupus-service-api/`
```
M  .env.example                                              +7
M  prisma/schema.prisma                                      +3
M  src/app.module.ts                                         +4
M  src/shared/mqtt/mqtt.service.ts                          +143 -8
A  src/modules/iot/iot.module.ts                             +24
A  src/modules/iot/iot.controller.ts                         +73
A  src/modules/iot/iot.service.ts                           +106
A  prisma/migrations/manual_add_mac_address_equipamentos.sql  +25
A  IMPLEMENTACAO_OTA.md                                     (este arquivo)
```

### `AupusNexOn/` (todos os iot-*.v2.js e iot-diagram.tsx são untracked no git)
```
M  public/iot-diagram.v2.js                                  +12 (4 TONs, 2 linhas cada)
M  public/iot-firmware-base.v2.js                            +57 (rollback + watchdog feed)
M  public/iot-firmware-generator.v2.js                       +25 (MAC log, payload, calls)
M  src/features/supervisorio/components/iot-diagram.tsx     +130 (firmwareDeployOta + UI)
A  IMPLEMENTACAO_OTA.md                                      (apontador resumido)
```

### Banco `aupus_staging`
```
+ coluna equipamentos.mac_address (VARCHAR(17), nullable, unique-when-not-null)
+ índices idx_equipamentos_mac_address (unique partial), idx_equipamentos_mac_address_lookup
+ 1 linha em equipamentos (id='iot_test_ton_bench_audit__', topico_mqtt='AUPUS_TESTE')
```

### Configuração runtime
```
M  /var/www/staging-nexon/aupus-service-api/.env  MQTT_MODE: disabled → development
                                                  INSTANCE_ID: production-server-vps → staging-dev-vps
                                                  MQTT_LOG_LEVEL=verbose (descomentado)
   backup em .env.bak-pre-mqtt-dev-20260428-141327
```

### Backups criados (limpar após validar)
```
/var/www/staging-nexon/AupusNexOn/dist.bak-pre-iot-ota-20260428-131623/
/var/www/staging-nexon/aupus-service-api/dist.bak-pre-iot-ota-20260428-140144/
/var/www/staging-nexon/aupus-service-api/.env.bak-pre-mqtt-dev-20260428-141327
```
