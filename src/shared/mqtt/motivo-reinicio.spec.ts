import { motivoDoReinicio } from './mqtt.service';

describe('motivoDoReinicio (12/11)', () => {
  it('traduz o motivo que a TON informa', () => {
    expect(motivoDoReinicio('Brownout')).toEqual({ texto: 'queda de tensão na alimentação (brownout)', severidade: 'ALTA' });
    expect(motivoDoReinicio('SW:reles').texto).toMatch(/relés sem controle/);
    expect(motivoDoReinicio('SW:ota').severidade).toBe('INFO');
    expect(motivoDoReinicio('SW:rede').texto).toMatch(/sem rede/);
    expect(motivoDoReinicio('Power-on').texto).toMatch(/energia/);
    expect(motivoDoReinicio(null).texto).toMatch(/não informado/);
  });
});
