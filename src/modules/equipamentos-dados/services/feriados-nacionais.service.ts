import { Injectable, Logger } from '@nestjs/common';

/**
 * Service para verificação de feriados nacionais brasileiros
 * Conforme Lei 12.111/2009 - Desconto para irrigantes em feriados nacionais
 *
 * Feriados considerados:
 * - 8 feriados fixos
 * - 3 feriados móveis (baseados na Páscoa)
 *
 * Nota: Feriados estaduais e municipais NÃO são considerados conforme legislação federal
 */
@Injectable()
export class FeriadosNacionaisService {
  private readonly logger = new Logger(FeriadosNacionaisService.name);

  // Cache de feriados por ano para performance
  private feriadosCache: Map<number, Set<string>> = new Map();

  /**
   * Verifica se uma data é feriado nacional
   * @param date Data a ser verificada
   * @returns true se for feriado nacional, false caso contrário
   */
  isFeriadoNacional(date: Date): boolean {
    // O banco armazena BRT como se fosse UTC — usar UTC methods
    const dia = date.getUTCDate();
    const mes = date.getUTCMonth() + 1; // 0-11 → 1-12
    const ano = date.getUTCFullYear();

    // Verificar feriados fixos primeiro (mais rápido)
    if (this.isFeriadoFixo(dia, mes)) {
      return true;
    }

    // Verificar feriados móveis (requer cálculo)
    return this.isFeriadoMovel(date);
  }

  /**
   * Verifica se é feriado fixo
   * @param dia Dia do mês (1-31)
   * @param mes Mês (1-12)
   */
  private isFeriadoFixo(dia: number, mes: number): boolean {
    const feriadosFixos = [
      [1, 1], // 1º de Janeiro - Confraternização Universal
      [21, 4], // 21 de Abril - Tiradentes
      [1, 5], // 1º de Maio - Dia do Trabalho
      [7, 9], // 7 de Setembro - Independência do Brasil
      [12, 10], // 12 de Outubro - Nossa Senhora Aparecida (Padroeira do Brasil)
      [2, 11], // 2 de Novembro - Finados
      [15, 11], // 15 de Novembro - Proclamação da República
      [25, 12], // 25 de Dezembro - Natal
    ];

    return feriadosFixos.some(([d, m]) => d === dia && m === mes);
  }

  /**
   * Verifica se é feriado móvel (baseado na Páscoa)
   * @param date Data a ser verificada
   */
  private isFeriadoMovel(date: Date): boolean {
    const ano = date.getUTCFullYear();

    // Buscar no cache
    if (!this.feriadosCache.has(ano)) {
      this.feriadosCache.set(ano, this.calcularFeriadosMoveis(ano));
    }

    const feriadosMoveis = this.feriadosCache.get(ano)!;
    const dataFormatada = this.formatarData(date);

    return feriadosMoveis.has(dataFormatada);
  }

  /**
   * Calcula todos os feriados móveis de um ano
   * @param ano Ano para cálculo
   * @returns Set de datas formatadas (YYYY-MM-DD)
   */
  private calcularFeriadosMoveis(ano: number): Set<string> {
    const pascoa = this.calcularPascoa(ano);

    const feriadosMoveis = new Set<string>();

    // Carnaval (terça-feira) - 47 dias antes da Páscoa
    feriadosMoveis.add(
      this.formatarData(this.adicionarDias(pascoa, -47)),
    );

    // Sexta-feira Santa - 2 dias antes da Páscoa
    feriadosMoveis.add(
      this.formatarData(this.adicionarDias(pascoa, -2)),
    );

    // Corpus Christi (quinta-feira) - 60 dias após a Páscoa
    feriadosMoveis.add(
      this.formatarData(this.adicionarDias(pascoa, 60)),
    );

    this.logger.debug(
      `Feriados móveis calculados para ${ano}: ${Array.from(feriadosMoveis).join(', ')}`,
    );

    return feriadosMoveis;
  }

  /**
   * Calcula a data da Páscoa usando o Algoritmo de Meeus
   * Referência: https://pt.wikipedia.org/wiki/Computa%C3%A7%C3%A3o_da_P%C3%A1scoa
   *
   * @param ano Ano para cálculo
   * @returns Data da Páscoa
   */
  private calcularPascoa(ano: number): Date {
    const a = ano % 19;
    const b = Math.floor(ano / 100);
    const c = ano % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const mes = Math.floor((h + l - 7 * m + 114) / 31);
    const dia = ((h + l - 7 * m + 114) % 31) + 1;

    return new Date(ano, mes - 1, dia);
  }

  /**
   * Adiciona dias a uma data
   * @param date Data base
   * @param dias Número de dias a adicionar (pode ser negativo)
   */
  private adicionarDias(date: Date, dias: number): Date {
    const resultado = new Date(date);
    resultado.setDate(resultado.getDate() + dias);
    return resultado;
  }

  /**
   * Formata data para string YYYY-MM-DD
   * @param date Data a formatar
   */
  private formatarData(date: Date): string {
    const ano = date.getUTCFullYear();
    const mes = String(date.getUTCMonth() + 1).padStart(2, '0');
    const dia = String(date.getUTCDate()).padStart(2, '0');
    return `${ano}-${mes}-${dia}`;
  }

  /**
   * Retorna lista de todos os feriados nacionais de um ano
   * Útil para debugging e documentação
   *
   * @param ano Ano para listar feriados
   */
  listarFeriados(ano: number): Array<{ data: string; nome: string }> {
    const feriados: Array<{ data: string; nome: string }> = [];

    // Feriados Fixos
    feriados.push(
      { data: `${ano}-01-01`, nome: 'Confraternização Universal' },
      { data: `${ano}-04-21`, nome: 'Tiradentes' },
      { data: `${ano}-05-01`, nome: 'Dia do Trabalho' },
      { data: `${ano}-09-07`, nome: 'Independência do Brasil' },
      { data: `${ano}-10-12`, nome: 'Nossa Senhora Aparecida' },
      { data: `${ano}-11-02`, nome: 'Finados' },
      { data: `${ano}-11-15`, nome: 'Proclamação da República' },
      { data: `${ano}-12-25`, nome: 'Natal' },
    );

    // Feriados Móveis
    const pascoa = this.calcularPascoa(ano);
    const carnaval = this.adicionarDias(pascoa, -47);
    const sextaSanta = this.adicionarDias(pascoa, -2);
    const corpusChristi = this.adicionarDias(pascoa, 60);

    feriados.push(
      { data: this.formatarData(carnaval), nome: 'Carnaval' },
      { data: this.formatarData(sextaSanta), nome: 'Sexta-feira Santa' },
      { data: this.formatarData(corpusChristi), nome: 'Corpus Christi' },
    );

    // Ordenar por data
    return feriados.sort((a, b) => a.data.localeCompare(b.data));
  }

  /**
   * Limpa o cache de feriados
   * Útil para testes ou para liberar memória
   */
  limparCache(): void {
    this.feriadosCache.clear();
    this.logger.debug('Cache de feriados limpo');
  }
}
