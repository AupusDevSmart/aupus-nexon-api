import { EquipamentosCmdService } from './equipamentos-cmd.service';

/**
 * pulsoRele: pulso na própria TON ("rN pulse <ms>") com volta ao on/off pelo backend quando
 * o firmware é antigo. O firmware antigo NÃO responde erro ao "pulse" (casa "on" por
 * substring → entende "off"), então só o ack "rele_N_pulse_*" vale como pulso local.
 */
function montar(respostas: Array<{ status: string; msg: string }>) {
  const enviados: string[] = [];
  const publicados: string[] = [];
  const mqtt = {
    publishCommand: jest.fn(async (_t: string, cmd: string) => {
      enviados.push(cmd);
      const r = respostas.shift() ?? { status: 'ok', msg: '' };
      return { cmd_id: 'x', status: r.status, msg: r.msg, ts: 0 };
    }),
    publish: jest.fn(async (_t: string, payload: string) => { publicados.push(JSON.parse(payload).cmd); }),
  };
  const svc = new EquipamentosCmdService({} as any, mqtt as any, {} as any, {} as any);
  (svc as any).sleep = async () => undefined;
  const pulso = (topico: string, n: number, ms: number) => (svc as any).pulsoRele(topico, n, ms);
  return { pulso, enviados, publicados };
}

describe('pulsoRele', () => {
  it('firmware novo: um comando só, sem "off" pelo backend', async () => {
    const { pulso, enviados, publicados } = montar([{ status: 'ok', msg: 'rele_1_pulse_500' }]);
    const r = await pulso('T', 1, 500);
    expect(enviados).toEqual(['r1 pulse 500']);
    expect(publicados).toEqual([]);
    expect(r.tecnico).toBe('r1 pulse 500');
  });

  it('firmware antigo (responde "rele_1_off"): volta ao on/off e lembra da TON', async () => {
    const { pulso, enviados, publicados } = montar([
      { status: 'ok', msg: 'rele_1_off' },
      { status: 'ok', msg: 'rele_1_on' },
      { status: 'ok', msg: 'rele_1_on' },
    ]);
    const r = await pulso('T', 1, 500);
    expect(enviados).toEqual(['r1 pulse 500', 'r1 on']);
    expect(publicados).toEqual(['r1 off']);
    expect(r.tecnico).toBe('r1 on -> 500ms -> r1 off');
    await pulso('T', 1, 500);   // mesma TON: nem tenta o pulse de novo
    expect(enviados).toEqual(['r1 pulse 500', 'r1 on', 'r1 on']);
  });

  it('"duplicate" (reenvio do mesmo cmd_id) conta como pulso feito — sem segundo pulso', async () => {
    const { pulso, enviados, publicados } = montar([{ status: 'duplicate', msg: '' }]);
    await pulso('T', 2, 500);
    expect(enviados).toEqual(['r2 pulse 500']);
    expect(publicados).toEqual([]);
  });

  it('erro da TON (ex.: pulso inválido) não cai no on/off', async () => {
    const { pulso, enviados } = montar([{ status: 'error', msg: 'pulso_invalido' }]);
    const r = await pulso('T', 3, 500);
    expect(enviados).toEqual(['r3 pulse 500']);
    expect(r.ack.status).toBe('error');
  });

  it('duração fora da faixa é limitada a 50..10000 ms', async () => {
    const { pulso, enviados } = montar([{ status: 'ok', msg: 'rele_1_pulse_10000' }]);
    await pulso('T', 1, 60000);
    expect(enviados).toEqual(['r1 pulse 10000']);
  });
});
