import { EquipamentosCmdService } from './equipamentos-cmd.service';

/** comandoTon (percentímetro): lora_no_ack repete uma vez e não manda regravar a TON. */
function montar(acks: Array<{ status: string; msg: string }>) {
  const enviados: string[] = [];
  const mqtt = {
    isConnected: () => true,
    publishCommand: jest.fn(async (_t: string, cmd: string) => { enviados.push(cmd); return { cmd_id: String(enviados.length), ...acks.shift()! }; }),
  };
  const prisma = { equipamentos: { findFirst: jest.fn(async ({ where }: any) => (where.id === 'TON' ? { id: 'TON', nome: 'TON4v2', topico_mqtt: 'X/sat/MAC' } : { nome: 'PIV-01' })) } };
  const svc = new EquipamentosCmdService(prisma as any, mqtt as any, {} as any, {} as any) as any;
  svc.registrarComando = jest.fn(async () => undefined);
  return { svc, enviados };
}
const P = { equipamentoId: 'PIV', tonId: 'TON', cmd: 'perc 5 500 60 6', rotulo: 'Percentímetro 50%', ackOk: /^perc_5_500$/ };

describe('comandoTon: lora_no_ack', () => {
  it('repete uma vez e segue quando a 2ª volta', async () => {
    const { svc, enviados } = montar([{ status: 'error', msg: 'lora_no_ack' }, { status: 'ok', msg: 'perc_5_500' }]);
    await expect(svc.comandoTon(P)).resolves.toMatchObject({ status: 'ok' });
    expect(enviados).toEqual([P.cmd, P.cmd]);
  });

  it('duas sem ack → erro de rádio, sem sugerir regravar', async () => {
    const { svc, enviados } = montar([{ status: 'error', msg: 'lora_no_ack' }, { status: 'error', msg: 'lora_no_ack' }]);
    await expect(svc.comandoTon(P)).rejects.toThrow(/rádio LoRa/);
    await expect(montar([{ status: 'error', msg: 'lora_no_ack' }, { status: 'error', msg: 'lora_no_ack' }]).svc.comandoTon(P)).rejects.not.toThrow(/regrave/);
    expect(enviados).toHaveLength(2);
  });

  it('firmware que não conhece o comando → sugere regravar, sem repetir', async () => {
    const { svc, enviados } = montar([{ status: 'error', msg: 'unknown_cmd' }]);
    await expect(svc.comandoTon(P)).rejects.toThrow(/regrave a TON/);
    expect(enviados).toHaveLength(1);
  });
});
