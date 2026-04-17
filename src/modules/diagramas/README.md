# Módulo de Diagramas Sinópticos

## ✅ Status: IMPLEMENTADO

Módulo completo para gerenciar diagramas sinópticos com equipamentos e conexões.

## 📁 Estrutura

```
src/modules/diagramas/
├── dto/
│   ├── create-diagrama.dto.ts          # DTO para criar diagrama
│   ├── update-diagrama.dto.ts          # DTO para atualizar diagrama
│   ├── add-equipamento-diagrama.dto.ts # DTOs para equipamentos
│   └── create-conexao.dto.ts           # DTOs para conexões
├── services/
│   ├── diagramas.service.ts            # CRUD de diagramas
│   ├── equipamentos-diagrama.service.ts # Gerenciar equipamentos no diagrama
│   └── conexoes-diagrama.service.ts    # Gerenciar conexões
├── diagramas.controller.ts             # Controller com todas as rotas
├── diagramas.module.ts                 # Módulo NestJS
├── diagramas.http                      # Arquivo de testes HTTP
└── README.md                           # Este arquivo
```

## 🚀 Rotas Implementadas

### Diagramas

- `POST   /api/v1/diagramas` - Criar diagrama
- `GET    /api/v1/diagramas/:id` - Obter diagrama
- `PATCH  /api/v1/diagramas/:id` - Atualizar diagrama
- `DELETE /api/v1/diagramas/:id` - Deletar diagrama

### Equipamentos no Diagrama

- `POST   /api/v1/diagramas/:id/equipamentos` - Adicionar equipamento
- `PATCH  /api/v1/diagramas/:id/equipamentos/:equipamentoId` - Atualizar posição
- `DELETE /api/v1/diagramas/:id/equipamentos/:equipamentoId` - Remover equipamento
- `POST   /api/v1/diagramas/:id/equipamentos/bulk` - Adicionar múltiplos equipamentos

### Conexões

- `POST   /api/v1/diagramas/:id/conexoes` - Criar conexão
- `PATCH  /api/v1/diagramas/:id/conexoes/:conexaoId` - Atualizar conexão
- `DELETE /api/v1/diagramas/:id/conexoes/:conexaoId` - Remover conexão
- `POST   /api/v1/diagramas/:id/conexoes/bulk` - Criar múltiplas conexões

## 🧪 Como Testar

### 1. Instalar dependências (se necessário)

```bash
npm install
```

### 2. Gerar o Prisma Client

```bash
npx prisma generate
```

### 3. Rodar as migrations (se ainda não rodou)

```bash
npx prisma migrate dev
```

### 4. Iniciar o servidor

```bash
npm run start:dev
```

### 5. Testar as rotas

Use o arquivo `diagramas.http` com a extensão REST Client do VS Code ou Insomnia/Postman.

**Passo a passo:**

1. **Obter token JWT**: Faça login e copie o token
2. **Edite o arquivo `diagramas.http`**:
   - Substitua `SEU_TOKEN_JWT_AQUI` pelo token
   - Substitua `ID_DA_UNIDADE_AQUI` por um ID de unidade válido
   - Substitua `ID_DO_EQUIPAMENTO_AQUI` por um ID de equipamento válido

3. **Executar os testes na ordem**:
   - Criar diagrama
   - Adicionar equipamentos
   - Criar conexões
   - Atualizar/Deletar conforme necessário

## 📊 Exemplo Completo

### 1. Criar Diagrama

```http
POST http://localhost:3000/api/v1/diagramas
Content-Type: application/json
Authorization: Bearer SEU_TOKEN

{
  "unidadeId": "unit_abc123",
  "nome": "Diagrama Principal",
  "descricao": "Diagrama sinóptico da UFV principal"
}
```

**Resposta:**
```json
{
  "success": true,
  "data": {
    "id": "diag_xyz789",
    "nome": "Diagrama Principal",
    "versao": "1.0",
    ...
  }
}
```

### 2. Adicionar Equipamento

```http
POST http://localhost:3000/api/v1/diagramas/diag_xyz789/equipamentos
Content-Type: application/json
Authorization: Bearer SEU_TOKEN

{
  "equipamentoId": "equip_001",
  "posicao": { "x": 100, "y": 200 },
  "rotacao": 0
}
```

### 3. Criar Conexão

```http
POST http://localhost:3000/api/v1/diagramas/diag_xyz789/conexoes
Content-Type: application/json
Authorization: Bearer SEU_TOKEN

{
  "origem": {
    "equipamentoId": "equip_001",
    "porta": "right"
  },
  "destino": {
    "equipamentoId": "equip_002",
    "porta": "left"
  },
  "visual": {
    "tipoLinha": "solida",
    "cor": "#22c55e"
  }
}
```

## ✅ Validações Implementadas

### Equipamentos
- ✅ Equipamento deve existir
- ✅ Equipamento deve pertencer à mesma unidade do diagrama
- ✅ Equipamento não pode estar em outro diagrama
- ✅ Coordenadas devem ser >= 0
- ✅ Rotação deve estar entre 0-360

### Conexões
- ✅ Equipamentos devem estar no diagrama
- ✅ Portas válidas: top, bottom, left, right
- ✅ Tipo de linha válido: solida, tracejada, pontilhada
- ✅ Espessura entre 1-10

## 🔄 Transações

As seguintes operações usam transações para garantir integridade:

- **Deletar diagrama**: Remove conexões e limpa posicionamento dos equipamentos
- **Remover equipamento**: Remove conexões associadas automaticamente

## 📝 Próximos Passos

- [ ] Adicionar WebSocket para tempo real
- [ ] Implementar MQTT para dados dos equipamentos
- [ ] Adicionar testes unitários
- [ ] Adicionar testes e2e
- [ ] Documentação Swagger completa

## 🐛 Troubleshooting

### Erro: "Diagrama não encontrado"
- Verifique se o ID do diagrama está correto
- Verifique se o diagrama não foi deletado (deleted_at)

### Erro: "Equipamento já está em outro diagrama"
- Primeiro remova o equipamento do diagrama atual
- Depois adicione ao novo diagrama

### Erro: "Equipamento não pertence à mesma unidade"
- O equipamento deve ser da mesma unidade que o diagrama

## 📚 Documentação Relacionada

- [API-ROTAS-DIAGRAMAS.md](../../../../docs/API-ROTAS-DIAGRAMAS.md) - Documentação completa das rotas
- [API-MQTT-TEMPO-REAL.md](../../../../docs/API-MQTT-TEMPO-REAL.md) - Documentação MQTT e tempo real
