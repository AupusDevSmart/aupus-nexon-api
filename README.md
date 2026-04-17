# aupus-nexon-api

API do produto **AupusNexOn** (supervisorio, sinoptico, dashboards de energia, MQTT).

Consome o pacote compartilhado `@aupus/api-shared` que contem os modulos em comum com `aupus-service-api` (auth, usuarios, plantas, unidades, equipamentos, etc).

## Porta

Roda em `3001` (o `aupus-service-api` roda em `3000`, podem coexistir).

## Modulos especificos desta API

- `diagramas` - diagramas sinopticos
- `equipamentos-dados` - dados MQTT historicos (grafico-dia, grafico-mes, latest, etc)
- `configuracao-demanda` - configuracoes de grafico de demanda por unidade
- `coa` - Centro de Operacoes Avancadas
- `logs-mqtt` - visualizacao de logs MQTT
- `regras-logs-mqtt` - cadastro de regras de log MQTT
- `uploads` - servir arquivos estaticos

## Modulos compartilhados (via @aupus/api-shared)

auth, usuarios, roles, permissions, plantas, unidades, equipamentos, tipos-equipamentos, categorias-equipamentos, concessionarias.

## Setup

1. Clonar o repo
2. Instalar dependencias: `pnpm install`
3. Copiar `.env.example` para `.env` e ajustar
4. Gerar Prisma Client: `npx prisma generate`
5. Sincronizar schema (se necessario): `npx prisma db push`
6. Rodar dev server: `pnpm start:dev`

## Banco de dados

Compartilha o mesmo banco PostgreSQL com o `aupus-service-api`. O schema Prisma vem do `@aupus/api-shared`.

## Arquitetura

```
aupus-nexon-api/
├── prisma/schema.prisma     (sincronizado manualmente com api-shared)
├── src/
│   ├── app.module.ts        importa modulos do @aupus/api-shared + especificos
│   ├── main.ts              porta 3001
│   ├── common/              utilidades especificas (interceptors, helpers)
│   ├── shared/              mqtt, adapters, pipes (NexOn-only)
│   ├── websocket/           WebSocket gateway para dados realtime
│   ├── config/              configuracoes de logger e sentry
│   └── modules/             NexOn-only (ver lista acima)
```
