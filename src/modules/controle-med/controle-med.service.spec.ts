import { ControleMedService } from './controle-med.service';
import { lerMinuto, MODOS_PADRAO } from './controle-med.calc';

/** Ciclo do controle pelo MED com banco/TON simulados: sombra registra, ativo envia, portão bloqueia. */

const UFVS = [{
  id: 'u1', nome: 'UFV 1', ordem: 1, p_estatico_kw: 90, zera_estagio2: false, watchdog_nativo: true, rota: 'internet',
  inversores: [{ id: 'INV1', nome: 'INV-01', pn_kw: 100, smax_kva: 110, qmax_pct: 44, sinal_q: 1, q_noturno: false }],
}];

function montar(modos: Record<string, string>, P_inv_w = 90_000) {
  const registros: any[] = [];
  const prisma: any = {
    $queryRaw: jest.fn(async (s: TemplateStringsArray) => {
      const sql = s.join('?');
      if (sql.includes('FROM equipamentos e LEFT JOIN unidades')) return [{ dc: 500, dg: 100 }];
      if (sql.includes('FROM controle_med_config WHERE')) return [{ params: { alvo_g_pct: 95 }, ufvs: UFVS, modos: { ...MODOS_PADRAO, ...modos }, versao: 1 }];
      if (sql.includes('FROM equipamentos_dados d')) return [{ id: 'INV1', ts: new Date(), p_w: P_inv_w, kw: null }];
      if (sql.includes('FROM ssu_minutos')) return [];
      return [];
    }),
    $executeRaw: jest.fn(async (s: TemplateStringsArray, ...v: unknown[]) => {
      if (s.join('?').includes('INSERT INTO controle_med_ciclos')) registros.push({ pedidos: JSON.parse(String(v[6])), comandos: JSON.parse(String(v[7])), entradas: JSON.parse(String(v[4])) });
      return 1;
    }),
  };
  const cmd: any = { enviarSetpoint: jest.fn(async () => ({ status: 'ok' })) };
  const mqtt: any = { on: jest.fn() };
  const svc = new ControleMedService(prisma, mqtt, {} as any, cmd) as any;
  return { svc, cmd, registros };
}

// exportando 150 kW no minuto, 25 kWh já no intervalo, 100 s para fechar: projeção ≈ 116,7 kW > 100
const minutoExportando = (o: Record<string, unknown> = {}) => lerMinuto({
  NSU: 7, cdo: 15, phf: 0, phr: 25000, sts: 1, qhfi: 0, qhfc: 0, qhri: 0, qhrc: 0, ke: 0.001, q: 2, seg: 100, posto: 2,
  ssu_err: 0, fim: 0, mphf: 0, mphr: 2500, mqhfi: 0, mqhfc: 0, mqhri: 0, mqhrc: 0, ...o,
}, Date.now())!;

describe('ciclo do controle pelo MED', () => {
  it('sombra: calcula o corte e registra "sombra", sem mandar nada à TON', async () => {
    const { svc, cmd, registros } = montar({ demanda_g: 'sombra' });
    await svc.ciclo('MED', 'SSU', minutoExportando());
    expect(cmd.enviarSetpoint).not.toHaveBeenCalled();
    expect(registros[0].pedidos.demanda_g.acao).toBe('reduzir');
    expect(registros[0].comandos[0].enviado_p).toBe('sombra');
    expect(registros[0].comandos[0].p_lim_kw).toBeLessThan(90);
  });

  it('ativo: manda o limite de potência (sp_limite_pct) ao inversor', async () => {
    const { svc, cmd, registros } = montar({ demanda_g: 'ativo' });
    await svc.ciclo('MED', 'SSU', minutoExportando());
    expect(cmd.enviarSetpoint).toHaveBeenCalledWith('INV1', 'sp_limite_pct', expect.any(Number));
    const pct = cmd.enviarSetpoint.mock.calls[0][2];
    expect(pct).toBeGreaterThanOrEqual(0);
    expect(pct).toBeLessThan(90);
    expect(registros[0].comandos[0].enviado_p).toBe('ok');
  });

  it('portão reprovado (sts=0): nenhum comando, motivo registrado', async () => {
    const { svc, cmd, registros } = montar({ demanda_g: 'ativo' });
    await svc.ciclo('MED', 'SSU', minutoExportando({ sts: 0 }));
    expect(cmd.enviarSetpoint).not.toHaveBeenCalled();
    expect(registros[0].comandos).toEqual([]);
    expect(registros[0].entradas.eventos.join(' ')).toMatch(/Portão de qualidade/);
  });

  it('retomada: depois do portão reprovado, só volta a atuar após N ciclos válidos', async () => {
    const { svc, cmd } = montar({ demanda_g: 'ativo' });
    await svc.ciclo('MED', 'SSU', minutoExportando({ sts: 0 }));
    await svc.ciclo('MED', 'SSU', minutoExportando({ seg: 100 }));
    await svc.ciclo('MED', 'SSU', minutoExportando({ seg: 100 }));
    expect(cmd.enviarSetpoint).not.toHaveBeenCalled();
    await svc.ciclo('MED', 'SSU', minutoExportando({ seg: 100 }));
    expect(cmd.enviarSetpoint).toHaveBeenCalled();
  });

  it('só FP ligado: o P não é mexido (R2/R4 só valem com limite dinâmico em uso)', async () => {
    const { svc, registros } = montar({ fp: 'sombra' });
    await svc.ciclo('MED', 'SSU', minutoExportando());
    expect(registros[0].comandos[0].muda_p).toBe(false);
  });

  it('demanda desligada: não decide nada', async () => {
    const { svc, cmd, registros } = montar({});
    await svc.ciclo('MED', 'SSU', minutoExportando());
    expect(cmd.enviarSetpoint).not.toHaveBeenCalled();
    expect(registros[0].pedidos.demanda_g).toBeUndefined();
  });
});
