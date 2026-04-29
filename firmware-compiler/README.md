# aupus-firmware-compiler

Servico HTTP standalone que compila firmware ESP32/ESP8266 via PlatformIO CLI
e serve como fonte de artefatos `.bin` para OTA do `aupus-nexon-api`.

Portado de `/var/www/iot_nexon/firmware-compiler/` (servidor de producao,
2026-04-29) como parte da migracao IoT/OTA para autonomia do `service-nexon/`.

## Quem chama

- `OtaService.compileAndPublish()` no `aupus-nexon-api`:
  - `POST /publish-artifact` — compila + salva em `artifacts/` + retorna URL
    + metadata. URL eh montada com `IOT_ARTIFACTS_PUBLIC_BASE_URL` + path
    devolvido aqui, e publicada via MQTT pro device.
- Frontend (IoTDiagram) pode chamar `/compile` direto pra obter `.bin` em
  base64 (uso menos comum — geralmente passa pelo `OtaService`).

## Endpoints

| Metodo | Path | Funcao |
|--------|------|--------|
| `GET`  | `/health` | Health check para PM2 / monitoramento |
| `POST` | `/compile` | Compila e retorna `.bin` em base64 (sem persistir) |
| `POST` | `/publish-artifact` | Compila, salva em `artifacts/`, retorna URL publica + md5 + sha256 |
| `GET`  | `/artifacts` | Lista metadata dos `.bin` ja gerados |
| `GET`  | `/prebuilt[/<file>]` | Serve binarios pre-compilados |

## Variaveis de ambiente

| Var | Default | Descricao |
|-----|---------|-----------|
| `PORT` | `3211` | Porta HTTP. Em DEV/standalone use `3211` para nao conflitar com o compiler legado em `:3210` |
| `ARTIFACTS_PUBLIC_PATH` | `/iot-compile/artifacts` | Path publico (sem dominio) que aparece nas URLs retornadas. Tem que bater com o `location` do nginx que serve `artifacts/` via alias |

`HOME` precisa apontar para a home onde `/root/.platformio/` (toolchain ESP)
foi instalada. Em prod o PM2 roda como root, default.

## Layout em runtime

```
firmware-compiler/
├── server.js            # codigo (versionado)
├── package.json         # metadata (versionado)
├── ecosystem.config.cjs # PM2 entry (versionado)
├── artifacts/           # .bin gerados — gitignored, GC mantem 5 mais recentes por device
├── prebuilt/            # .bin pre-compilados — versionado seletivamente
└── /tmp/nexon-firmware/ # working dir temporario do pio (fora do repo, criado on demand)
```

## Local DEV

```bash
# Pre-requisito: PlatformIO instalado (pip install platformio ou via VSCode)
which pio
node server.js
# em outra aba:
curl http://localhost:3211/health
```

Em prod, gerenciado pelo PM2 via `ecosystem.config.cjs`. O `deploy.sh` do
`aupus-nexon-api` roda `pnpm install` e `pm2 startOrReload` deste subdir
apos o build da API principal.

## Por que subdir e nao repo separado

O compiler so eh consumido pelo `aupus-nexon-api`. Lifecycle e contrato
estao acoplados (mudancas em `OtaService.compileArtifact` exigem mudanca
correspondente aqui). Subdir mantem o codigo no mesmo `git pull`, evita
overhead de release coordenada entre repos. Se algum dia surgir segundo
consumer, extracao para repo proprio eh trivial via `git filter-repo
--subdirectory-filter firmware-compiler`.
