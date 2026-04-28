# Scripts de Gerenciamento de Equipamentos

## Arquivos Disponíveis

### 1. `fix-tipo-equipamento-ids.js`
**Função:** Corrige IDs órfãos de tipos de equipamentos

**Quando usar:** Quando equipamentos estiverem com `tipo_equipamento_id` inválido

**Como executar:**
```bash
cd aupus-service-api
node -r dotenv/config prisma/scripts/fix-tipo-equipamento-ids.js
```

**O que faz:**
- Identifica equipamentos com `tipo_equipamento_id` que não existe na tabela `tipos_equipamentos`
- Corrige automaticamente baseado no padrão do ID
- Exibe relatório detalhado de correções

---

### 2. `reset-and-seed-equipamentos.js` ⭐ NOVO
**Função:** Remove todos os equipamentos e popula com dados realistas e completos

**⚠️ ATENÇÃO:** Este script **DELETA TODOS OS EQUIPAMENTOS** existentes!

**Como executar:**
```bash
cd aupus-service-api
node -r dotenv/config prisma/scripts/reset-and-seed-equipamentos.js
```

**O que faz:**

#### Passo 1: Limpeza
Remove todos os dados de:
- ✅ `equipamentos_conexoes` (conexões entre equipamentos)
- ✅ `equipamentos_dados` (dados históricos MQTT)
- ✅ `equipamentos_dados_tecnicos` (dados técnicos)
- ✅ `equipamentos` (todos os equipamentos)

#### Passo 2: População Inteligente
Cria equipamentos apropriados para cada tipo de unidade:

##### UFV (Usina Fotovoltaica) - 8 equipamentos
1. **Medidor Principal** (Landis+Gyr E750)
2. **Transformador Principal** (WEG TTR-500)
3. **Inversor Central 1** (ABB PVS-100-TL)
4. **Inversor Central 2** (ABB PVS-100-TL)
5. **String Box 1** (Phoenix Contact)
6. **String Box 2** (Phoenix Contact)
7. **String Box 3** (Phoenix Contact)
8. **Disjuntor Geral** (Schneider NSX400)

##### Transformador - 4 equipamentos
1. **Transformador Principal** (WEG TTR-2500)
2. **Medidor AT** (Landis+Gyr E650)
3. **Medidor BT** (Landis+Gyr E350)
4. **Disjuntor AT** (Schneider NSX630)

##### Inversor - 3 equipamentos
1. **Inversor Central** (SMA Sunny Central 500)
2. **Medidor DC** (Phoenix Contact)
3. **Medidor AC** (Landis+Gyr E450)

##### Motor - 3 equipamentos
1. **Motor Principal** (WEG W22-150HP)
2. **Medidor do Motor** (Schneider PM5560)
3. **Soft Starter** (WEG SSW06)

##### Carga - 3 equipamentos
1. **Quadro Distribuição** (Schneider QD-400A)
2. **Medidor de Consumo** (Landis+Gyr E450)
3. **Banco de Capacitores** (WEG BC-150kVAr)

---

## Campos Preenchidos em Cada Equipamento

Todos os equipamentos criados incluem:

### Identificação
- ✅ `nome` - Nome descritivo
- ✅ `tag` - TAG única baseada no tipo e unidade
- ✅ `classificacao` - 'UC' (Unidade Consumidora)

### Tipo e Relacionamentos
- ✅ `tipo_equipamento_id` - ID válido da tabela `tipos_equipamentos`
- ✅ `unidade_id` - ID da unidade
- ✅ `planta_id` - ID da planta

### Fabricante e Modelo
- ✅ `fabricante` - Fabricante real (WEG, ABB, Schneider, etc)
- ✅ `modelo` - Modelo específico
- ✅ `numero_serie` - Número de série único gerado

### Gestão de Ativos
- ✅ `criticidade` - 1 (crítico) a 5 (baixa)
- ✅ `em_operacao` - 'sim'
- ✅ `localizacao` - Local físico do equipamento
- ✅ `valor_imobilizado` - Valor de aquisição
- ✅ `valor_contabil` - Valor contábil atual
- ✅ `vida_util` - Anos de vida útil

### Status
- ✅ `status` - 'NORMAL'

---

## Validação Pós-Execução

Após executar o script, você pode validar executando:

```bash
# Contar total de equipamentos
curl -s "http://localhost:3000/api/v1/equipamentos?limit=1" | grep -o '"total":[0-9]*'

# Listar equipamentos de uma unidade específica
curl -s "http://localhost:3000/api/v1/unidades/{UNIDADE_ID}/equipamentos?limit=100"

# Verificar tipos de equipamentos
curl -s "http://localhost:3000/api/v1/tipos-equipamentos"
```

---

## Troubleshooting

### Erro: "Can't reach database server"
**Causa:** Banco de dados não está acessível

**Solução:**
1. Verifique se o PostgreSQL está rodando
2. Verifique as credenciais no arquivo `.env`
3. Teste a conexão: `psql -h 45.55.122.87 -U admin -d aupus`

### Erro: "tipo_equipamento_id não existe"
**Causa:** Tipos de equipamentos não estão cadastrados

**Solução:**
1. Execute as migrations primeiro: `npm run prisma:migrate`
2. Ou popule os tipos manualmente

### Script trava ou não responde
**Causa:** Muitas unidades ou dados

**Solução:**
1. Ajuste o `take: 20` na linha 58 para um número menor
2. Execute em etapas, comentando partes do código

---

## Exemplo de Saída Esperada

```
🔄 Iniciando reset e seed de equipamentos...

🗑️  PASSO 1: Limpando dados existentes...

   ✅ Removidas 45 conexões
   ✅ Removidos 1234 dados históricos
   ✅ Removidos 89 dados técnicos
   ✅ Removidos 156 equipamentos

📋 PASSO 2: Buscando dados de referência...

   ✅ Encontradas 15 unidades
   ✅ Encontrados 32 tipos de equipamentos

📦 PASSO 3: Populando equipamentos...

   🏢 Unidade: UFV Solar Power Sul (UFV)
      ✅ Medidor Principal - UFV Solar Power Sul
      ✅ Transformador Principal - UFV Solar Power Sul
      ✅ Inversor Central 1 - UFV Solar Power Sul
      ✅ Inversor Central 2 - UFV Solar Power Sul
      ✅ String Box 1 - UFV Solar Power Sul
      ✅ String Box 2 - UFV Solar Power Sul
      ✅ String Box 3 - UFV Solar Power Sul
      ✅ Disjuntor Geral - UFV Solar Power Sul

   ... [mais unidades]

✅ Total de equipamentos criados: 120

🎉 Seed concluído com sucesso!
```

---

## Manutenção

Para adicionar novos tipos de equipamentos ou modificar os existentes:

1. Edite o arquivo `reset-and-seed-equipamentos.js`
2. Localize o `switch(unidade.tipo)` (linha ~94)
3. Adicione ou modifique os equipamentos conforme necessário
4. Certifique-se de que o `tipo_equipamento_id` aponta para um tipo válido em `tiposPorCodigo`

---

## Notas Importantes

- ⚠️ **SEMPRE FAÇA BACKUP** antes de executar o reset
- ✅ Os números de série são gerados dinamicamente usando timestamp
- ✅ TAGs são únicas por unidade
- ✅ Todos os equipamentos são criados como 'UC' (Unidade Consumidora)
- ✅ Não cria componentes UAR automaticamente (pode ser adicionado se necessário)
