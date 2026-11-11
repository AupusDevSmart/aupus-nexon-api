import { PivoAnguloAlarmeService } from './pivo-angulo-alarme.service';

/**
 * NEXON-103, seção 7 — alarmes do ângulo. O que importa aqui é NÃO alarmar à toa
 * (TON fora do ar, irrigando parado, API recém-reiniciada) e fechar quando deve.
 */

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 11, 12, 0, 0);

interface Cena {
  angulo?: number | null;
  semCalibracao?: boolean;
  idadeLeituraMs?: number | null;
  dir?: 'D' | 'E' | null;
  percentual?: number | null;
  tonIdadeMs?: number | null;
}

function montar(parametros: Record<string, unknown> = { encoder_equipamento_id: 'enc-1', encoder_resolucao: 4096, tempo_volta_100: 21 }) {
  const abertos: Array<{ id: string; equipamento_id: string; dados_snapshot: any; resolvido: boolean; mensagem: string }> = [];
  let pivos = [{ id: 'pivo-11', nome: 'Pivo 11', parametros }];
  let cena: Cena = {};
  let agora = T0;
  const prisma: any = {
    $queryRaw: jest.fn(async (s: TemplateStringsArray) => {
      const q = s.join('?');
      if (q.includes('FROM pivo_config')) return pivos;
      if (q.includes('FROM logs_mqtt')) return abertos.filter((a) => !a.resolvido).map((a) => ({ id: a.id, equipamento_id: a.equipamento_id, dados_snapshot: a.dados_snapshot }));
      return [];
    }),
    $executeRaw: jest.fn(async (s: TemplateStringsArray, ...v: any[]) => {
      if (s.join('?').includes('UPDATE logs_mqtt SET resolvido_em')) {
        const a = abertos.find((x) => x.id === v[1]);
        if (a) { a.resolvido = true; a.dados_snapshot = JSON.parse(v[0]); }
      }
      return 1;
    }),
    logs_mqtt: {
      create: jest.fn(async ({ data }: any) => {
        abertos.push({ id: `al-${abertos.length + 1}`, equipamento_id: data.equipamento_id, dados_snapshot: data.dados_snapshot, resolvido: false, mensagem: data.mensagem });
      }),
    },
  };
  const seq: any = {
    posicao: jest.fn(async () => ({
      fonte: 'encoder', angulo: cena.semCalibracao ? null : cena.angulo ?? null, bruto: 1, motivo: null, encoder: {},
      lido_em: cena.idadeLeituraMs === null ? null : new Date(agora - (cena.idadeLeituraMs ?? 30_000)),
      sem_calibracao: !!cena.semCalibracao, calibracao: null,
    })),
    giroAtual: jest.fn(async () => ({
      dir: cena.dir ?? null, lido: true, percentual: cena.percentual === undefined ? 100 : cena.percentual,
      ton: cena.tonIdadeMs === null ? null : { em: new Date(agora - (cena.tonIdadeMs ?? 20_000)), e: cena.dir ? 2 : 0 },
    })),
  };
  let svc = new PivoAnguloAlarmeService(prisma, seq);
  return {
    abertos,
    passo: async (min: number, c: Cena) => { agora = T0 + min * MIN; cena = c; await svc.avaliarTodos(agora); },
    reiniciarApi: () => { svc = new PivoAnguloAlarmeService(prisma, seq); },
    tirarEncoder: () => { pivos = []; },
    vivos: () => abertos.filter((a) => !a.resolvido).map((a) => a.dados_snapshot.codigo),
  };
}

describe('alarmes do ângulo do pivô', () => {
  describe('encoder sem resposta', () => {
    it('TON viva e 5 min sem leitura: abre; leitura voltou: fecha', async () => {
      const m = montar();
      await m.passo(0, { idadeLeituraMs: 6 * MIN });
      expect(m.vivos()).toEqual(['encoder_sem_resposta']);
      await m.passo(1, { idadeLeituraMs: 7 * MIN });
      expect(m.abertos).toHaveLength(1);   // não duplica
      await m.passo(2, { idadeLeituraMs: 20_000 });
      expect(m.vivos()).toEqual([]);
    });

    it('TON fora do ar: quem avisa é o alarme de comunicação, não este', async () => {
      const m = montar();
      await m.passo(0, { idadeLeituraMs: 30 * MIN, tonIdadeMs: 10 * MIN });
      await m.passo(1, { idadeLeituraMs: null, tonIdadeMs: null });
      expect(m.abertos).toHaveLength(0);
    });

    it('tiraram o encoder da Configuração: o alarme aberto fecha', async () => {
      const m = montar();
      await m.passo(0, { idadeLeituraMs: 6 * MIN });
      m.tirarEncoder();
      await m.passo(1, {});
      expect(m.vivos()).toEqual([]);
    });
  });

  describe('sentido invertido', () => {
    it('direita com o ângulo caindo mais de 2°: abre uma vez só', async () => {
      const m = montar();
      await m.passo(0, { dir: 'D', angulo: 100 });
      await m.passo(1, { dir: 'D', angulo: 98.5 });
      expect(m.vivos()).toEqual([]);
      await m.passo(2, { dir: 'D', angulo: 97 });
      expect(m.vivos()).toEqual(['sentido_invertido']);
      expect(m.abertos[0].mensagem).toBe('Pivo 11: Sentido invertido — recalibrar');
      await m.passo(3, { dir: 'D', angulo: 90 });
      expect(m.abertos).toHaveLength(1);
    });

    it('virada 359 → 0 andando para a direita: sem alarme', async () => {
      const m = montar();
      for (const [i, a] of [357, 358.5, 359.8, 0.9, 2.2].entries()) await m.passo(i, { dir: 'D', angulo: a });
      expect(m.abertos).toHaveLength(0);
    });

    it('sem calibração não julga o sentido', async () => {
      const m = montar();
      await m.passo(0, { dir: 'D', angulo: 100, semCalibracao: true });
      await m.passo(1, { dir: 'D', angulo: 90, semCalibracao: true });
      expect(m.abertos).toHaveLength(0);
    });
  });

  describe('pivô travado', () => {
    it('girando com o ângulo parado pelo prazo: abre; andou: fecha', async () => {
      const m = montar();
      await m.passo(0, { dir: 'D', angulo: 50 });
      await m.passo(9, { dir: 'D', angulo: 50 });
      expect(m.vivos()).toEqual([]);
      await m.passo(10, { dir: 'D', angulo: 50 });
      expect(m.vivos()).toEqual(['pivo_travado']);
      await m.passo(11, { dir: 'D', angulo: 51 });
      expect(m.vivos()).toEqual([]);
    });

    it('parou: fecha', async () => {
      const m = montar();
      await m.passo(0, { dir: 'D', angulo: 50 });
      await m.passo(10, { dir: 'D', angulo: 50 });
      await m.passo(11, { dir: null, angulo: 50 });
      expect(m.vivos()).toEqual([]);
    });

    it('TON fora do ar com o pivô "girando" e o ângulo congelado: não é travado', async () => {
      const m = montar();
      await m.passo(0, { dir: 'D', angulo: 50 });
      for (let t = 1; t <= 14; t++) await m.passo(t, { dir: 'D', angulo: 50, tonIdadeMs: t * MIN, idadeLeituraMs: t * MIN });
      expect(m.abertos.filter((a) => a.dados_snapshot.codigo === 'pivo_travado')).toHaveLength(0);
    });

    it('irrigando parado (0 %): não alarma', async () => {
      const m = montar();
      for (let t = 0; t <= 30; t += 5) await m.passo(t, { dir: 'D', angulo: 50, percentual: 0 });
      expect(m.abertos).toHaveLength(0);
    });

    it('ligado no painel, velocidade desconhecida: não alarma', async () => {
      const m = montar();
      for (let t = 0; t <= 30; t += 5) await m.passo(t, { dir: 'D', angulo: 50, percentual: null });
      expect(m.abertos).toHaveLength(0);
    });

    it('a 10 % o prazo estica: 10 min parado ainda não é travado', async () => {
      const m = montar({ encoder_equipamento_id: 'enc-1', encoder_resolucao: 360, tempo_volta_100: 21 });
      await m.passo(0, { dir: 'D', angulo: 50, percentual: 10 });
      await m.passo(60, { dir: 'D', angulo: 50, percentual: 10 });
      expect(m.vivos()).toEqual([]);
      await m.passo(106, { dir: 'D', angulo: 50, percentual: 10 });
      expect(m.vivos()).toEqual(['pivo_travado']);
    });

    it('API reiniciou com o alarme aberto e o pivô ainda travado: continua aberto, sem duplicar', async () => {
      const m = montar();
      await m.passo(0, { dir: 'D', angulo: 50 });
      await m.passo(10, { dir: 'D', angulo: 50 });
      m.reiniciarApi();
      await m.passo(11, { dir: 'D', angulo: 50 });
      await m.passo(25, { dir: 'D', angulo: 50 });
      expect(m.vivos()).toEqual(['pivo_travado']);
      expect(m.abertos).toHaveLength(1);
    });

    it('prazo configurável (travado_min)', async () => {
      const m = montar({ encoder_equipamento_id: 'enc-1', encoder_resolucao: 4096, tempo_volta_100: 21, travado_min: 20 });
      await m.passo(0, { dir: 'D', angulo: 50 });
      await m.passo(15, { dir: 'D', angulo: 50 });
      expect(m.vivos()).toEqual([]);
      await m.passo(20, { dir: 'D', angulo: 50 });
      expect(m.vivos()).toEqual(['pivo_travado']);
    });
  });
});
