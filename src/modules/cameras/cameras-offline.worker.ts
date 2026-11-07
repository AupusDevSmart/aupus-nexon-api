import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '@/core';
import { CamerasEventosService } from './cameras-eventos.service';
import { SEM_CONTATO_S } from './cameras-regras';

/**
 * A cada minuto: câmera sem contato há mais de 3 min (ou cujo agente está sem contato há mais
 * de 3 min) e ainda não offline → offline + evento sem_sinal (alerta, sem repetir). Câmera que
 * nunca falou (desconhecido, sem contato do agente) fica como está. CAMERAS_WORKER=off desliga.
 */
@Injectable()
export class CamerasOfflineWorker {
  private readonly logger = new Logger(CamerasOfflineWorker.name);
  private rodando = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventos: CamerasEventosService,
  ) {}

  @Interval(60_000)
  async tick() {
    if (this.rodando || process.env.CAMERAS_WORKER === 'off') return;
    this.rodando = true;
    try {
      const n = await this.processar();
      if (n) this.logger.log(`[cameras] ${n} câmera(s) marcadas offline por falta de contato`);
    } catch (e) {
      this.logger.warn(`[cameras] worker offline: ${(e as Error).message}`);
    } finally {
      this.rodando = false;
    }
  }

  async processar(agora = new Date()): Promise<number> {
    const limite = new Date(agora.getTime() - SEM_CONTATO_S * 1000);
    const cameras = await this.prisma.cameras.findMany({
      where: {
        deleted_at: null,
        status: { not: 'offline' },
        OR: [{ ultimo_contato_em: { lt: limite } }, { agente: { ultimo_contato_em: { lt: limite } } }],
      },
      select: {
        id: true,
        nome: true,
        ip: true,
        unidade_id: true,
        planta_id: true,
        equipamento_id: true,
        status: true,
        status_em: true,
        publicando: true,
        analise: true,
      },
    });
    let n = 0;
    for (const c of cameras) {
      try {
        await this.eventos.marcarOffline(c, agora);
        n++;
      } catch (e) {
        this.logger.warn(`[cameras] não marcou ${c.nome} (${c.id}) offline: ${(e as Error).message}`);
      }
    }
    return n;
  }
}
