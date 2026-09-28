import { extrairClienteInfo, rotuloNavegador } from './cliente-info';

describe('cliente-info', () => {
  it('app: "<aparelho> · <plataforma>" dos headers X-Client-*', () => {
    const c = extrairClienteInfo({
      headers: { 'x-client-platform': 'iOS', 'x-client-device': 'iPhone 15 Pro', 'x-forwarded-for': '1.2.3.4, 10.0.0.1' },
    });
    expect(c.dispositivo).toBe('iPhone 15 Pro · iOS');
    expect(c.plataforma).toBe('iOS');
    expect(c.ip).toBe('1.2.3.4');
  });

  it('web sem headers: rótulo pelo User-Agent', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
    const c = extrairClienteInfo({ headers: { 'user-agent': ua }, ip: '::ffff:127.0.0.1' });
    expect(c.dispositivo).toBe('Chrome no Windows');
    expect(c.plataforma).toBe('Web');
    expect(c.ip).toBe('127.0.0.1');
    expect(rotuloNavegador(null)).toBe('Web');
  });
});
