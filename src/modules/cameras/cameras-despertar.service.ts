import { Injectable } from '@nestjs/common';

/** Teto da espera do agente em `GET /cameras/agente/config?aguardar=` (o nginx corta em 60 s). */
export const DESPERTAR_MAX_S = 25;

/**
 * Acorda o agente na hora em que há trabalho para ele (vídeo pedido, comando novo), em vez de esperar o
 * próximo ciclo de consulta (5 s). O agente chama `GET /cameras/agente/config?aguardar=20&seq=N`: a resposta
 * sai assim que `despertar()` for chamado para ele, ou depois de `aguardar` segundos sem novidade.
 *
 * Em memória: vale com a API em um processo só (pm2 fork). Com várias instâncias o agente continua certo,
 * só que no ritmo da espera máxima, como antes.
 */
@Injectable()
export class CamerasDespertarService {
  /** Sinal por agente: cresce a cada despertar; o agente devolve o último que viu. */
  private readonly seqs = new Map<string, number>();
  private readonly esperas = new Map<string, Set<() => void>>();

  seq(agenteId: string): number {
    return this.seqs.get(agenteId) ?? 0;
  }

  despertar(agenteId: string | null | undefined): void {
    if (!agenteId) return;
    this.seqs.set(agenteId, this.seq(agenteId) + 1);
    const fila = this.esperas.get(agenteId);
    if (!fila) return;
    this.esperas.delete(agenteId);
    for (const acordar of fila) acordar();
  }

  /**
   * Espera até `segundos` por um despertar. Volta na hora se já houve sinal depois do `seqVisto`
   * (o pedido de vídeo chegou entre duas consultas do agente).
   */
  async aguardar(agenteId: string, segundos: number, seqVisto?: number): Promise<void> {
    const s = Math.min(DESPERTAR_MAX_S, Math.max(0, segundos));
    if (s <= 0) return;
    if (seqVisto !== undefined && this.seq(agenteId) !== seqVisto) return;
    await new Promise<void>((resolve) => {
      let fila = this.esperas.get(agenteId);
      if (!fila) {
        fila = new Set();
        this.esperas.set(agenteId, fila);
      }
      const acordar = () => {
        clearTimeout(t);
        resolve();
      };
      const t = setTimeout(() => {
        fila!.delete(acordar);
        if (fila!.size === 0 && this.esperas.get(agenteId) === fila) this.esperas.delete(agenteId);
        resolve();
      }, s * 1000);
      fila.add(acordar);
    });
  }
}
