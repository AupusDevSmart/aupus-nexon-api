/**
 * equipamentos_dados.timestamp_dados é `timestamp(0)` (segundos inteiros). Gravar com
 * milissegundos quebra o upsert do Prisma: se já existe linha no mesmo segundo, o banco
 * arredonda e bate na chave única, mas o Prisma relê pela chave COM ms e não acha →
 * P2025 "Record not found" (reproduzido 10/10/2026). Toda escrita/consulta pela chave usa isto.
 */
export const emSegundos = (d: Date): Date => new Date(Math.floor(new Date(d).getTime() / 1000) * 1000);
