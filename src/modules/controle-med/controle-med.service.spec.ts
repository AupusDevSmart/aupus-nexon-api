import { ControleMedService } from './controle-med.service';
import { lerMinuto, MODOS_PADRAO } from './controle-med.calc';
import { hashCadastro } from './controle-med.ton';

/** Ciclo do controle pelo MED com banco/TON simulados: sombra registra, ativo envia, portão bloqueia. */

const UFVS = [{
  id: 'u1', nome: 'UFV 1', ordem: 1, p_estatico_kw: 90, zera_estagio2: false, watchdog_nativo: true, rota: 'internet',
  inversores: [{ id: 'INV1', nome: 'INV-01', pn_kw: 100, smax_kva: 110, qmax_pct: 44, sinal_q: 1, q_noturno: false }],
}];

/** TON da UFV simulada como o firmware (lib controle_ufv): cadastro, hash, ctl, status/off. */
function tonSim(o: { antigo?: boolean; resumo?: string } = {}) {
  const st = { linhas: [] as string[], cmds: [] as string[], modo: 'D' };
  const ok = (msg: string) => ({ status: 'ok', msg, latency_ms: 1 });
  const h = () => hashCadastro(st.linhas);
  const fn = jest.fn(async (_ton: string, c: string) => {
    st.cmds.push(c);
    if (o.antigo) return { status: 'error', msg: 'unknown_cmd', latency_ms: 1 };
    if (c.startsWith('ctl geral')) { st.linhas = [c]; return ok(`cfg_ok c=${h()}`); }
    if (c.startsWith('ctl cfg')) { st.linhas.push(c); return ok(`cfg_ok c=${h()}`); }
    if (c === 'ctl off') { st.modo = 'D'; return ok(`D c=${h()}`); }
    if (c === 'ctl status') return ok(`${st.modo} c=${h()} v=-1 seq=0 n=${st.linhas.length - 1} e=0`);
    if (!st.linhas.length) return { status: 'error', msg: 'sem_cfg c=000000', latency_ms: 1 };
    st.modo = 'A';
    return ok(`A c=${h()}${o.resumo ?? ''} 1:ok`);
  });
  return { st, fn };
}

function montar(modos: Record<string, string>, P_inv_w = 90_000, ton = tonSim()) {
  const registros: any[] = [];
  const prisma: any = {
    $queryRaw: jest.fn(async (s: TemplateStringsArray) => {
      const sql = s.join('?');
      if (sql.includes('FROM equipamentos e LEFT JOIN unidades')) return [{ dc: 500, dg: 50 }];   // contrato 50 < Pn 100: sobra o que cortar acima do piso
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
  const cmd: any = {
    enviarSetpoint: jest.fn(async () => ({ status: 'ok' })),
    alvoControle: jest.fn(async () => ({
      dev: 'INV-01', addr: 1, tonId: 'TON1', tonNome: 'TON UFV',
      p: { escala: 10, min: 0, max: 1000 }, q: { escala: 10, min: -1000, max: 1000 },
    })),
    comandoTonCru: ton.fn,
  };
  const mqtt: any = { on: jest.fn() };
  const svc = new ControleMedService(prisma, mqtt, {} as any, cmd) as any;
  return { svc, cmd, registros, ton: ton.st };
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

  it('ativo: cadastra a TON e manda o limite com validade ("ctl <seq> <ttl> 1 <p> <q>")', async () => {
    const { svc, cmd, registros, ton } = montar({ demanda_g: 'ativo' });
    await svc.ciclo('MED', 'SSU', minutoExportando());
    expect(cmd.enviarSetpoint).not.toHaveBeenCalled();
    // 1º ctl: sem cadastro -> geral + cfg -> ctl de novo
    expect(ton.cmds[1]).toBe('ctl geral 1 600 0 0');
    expect(ton.cmds[2]).toBe('ctl cfg 1 1 900 900 1000 100 INV-01');   // P estático 90 kW / Pn 100 = 90 %
    const m = ton.cmds[3].match(/^ctl (\d+) 180 1 (\d+) (-?\d+)$/)!;
    expect(m).toBeTruthy();
    expect(Number(m[2])).toBeLessThan(900);   // limite em % x10, abaixo dos 90 %
    expect(registros[0].comandos[0].enviado_p).toBe('ok');
    expect(registros[0].entradas.eventos.join(' ')).toMatch(/cadastro do controle local enviado/);
  });

  it('ativo: heartbeat a cada ciclo, sem reenviar o cadastro', async () => {
    const { svc, ton } = montar({ demanda_g: 'ativo' });
    await svc.ciclo('MED', 'SSU', minutoExportando());
    const n = ton.cmds.length;
    await svc.ciclo('MED', 'SSU', minutoExportando({ seg: 40 }));
    const novos = ton.cmds.slice(n);
    expect(novos).toHaveLength(1);
    expect(novos[0]).toMatch(/^ctl \d+ 180 1 \d+ -?\d+$/);
  });

  it('firmware antigo (unknown_cmd): cai no setpoint por inversor e avisa', async () => {
    const { svc, cmd, registros } = montar({ demanda_g: 'ativo' }, 90_000, tonSim({ antigo: true }));
    await svc.ciclo('MED', 'SSU', minutoExportando());
    expect(cmd.enviarSetpoint).toHaveBeenCalledWith('INV1', 'sp_limite_pct', expect.any(Number));
    expect(registros[0].entradas.eventos.join(' ')).toMatch(/firmware sem o controle local/);
  });

  it('TON informa tempo em modo seguro: vira evento do ciclo', async () => {
    const { svc, registros } = montar({ demanda_g: 'ativo' }, 90_000, tonSim({ resumo: ' s=320 p=S2' }));
    await svc.ciclo('MED', 'SSU', minutoExportando());
    expect(registros[0].entradas.eventos.join(' ')).toMatch(/320 s em modo seguro \(chegou ao estágio 2\)/);
  });

  it('sombra depois do restart: confere o modo da TON e desliga se ficou armada', async () => {
    const t = tonSim();
    t.st.linhas = ['ctl geral 1 600 0 0']; t.st.modo = 'S1';
    const { svc, ton } = montar({ demanda_g: 'sombra' }, 90_000, t);
    await svc.ciclo('MED', 'SSU', minutoExportando());
    expect(ton.cmds).toEqual(['ctl status', 'ctl off']);
    await svc.ciclo('MED', 'SSU', minutoExportando());
    expect(ton.cmds).toHaveLength(2);   // só uma vez
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
    expect(cmd.comandoTonCru).not.toHaveBeenCalled();   // sem renovar: a validade vence e a TON vai ao modo seguro
    await svc.ciclo('MED', 'SSU', minutoExportando({ seg: 100 }));
    expect(cmd.comandoTonCru).toHaveBeenCalled();
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
