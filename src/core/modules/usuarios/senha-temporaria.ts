import { randomInt } from 'crypto';

// Sem caracteres que se confundem lidos no celular (0/O, 1/l/I).
const LETRAS = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITOS = '23456789';

/**
 * Senha temporária legível para mandar por e-mail: 10 caracteres, letras e
 * ao menos 2 dígitos, gerada com `crypto.randomInt` (NEXON-129).
 */
export function gerarSenhaTemporaria(tamanho = 10): string {
  const todos = LETRAS + DIGITOS;
  const chars: string[] = [];
  chars.push(DIGITOS[randomInt(DIGITOS.length)], DIGITOS[randomInt(DIGITOS.length)]);
  chars.push(LETRAS[randomInt(LETRAS.length)]);
  while (chars.length < tamanho) chars.push(todos[randomInt(todos.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}
