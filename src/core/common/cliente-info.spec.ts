import type { AddressInfo } from 'net';
import * as http from 'http';
import { extrairClienteInfo, rotuloNavegador } from './cliente-info';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const express = require('express');

describe('cliente-info', () => {
  it('app: "<aparelho> · <plataforma>" dos headers X-Client-*', () => {
    const c = extrairClienteInfo({
      headers: { 'x-client-platform': 'iOS', 'x-client-device': 'iPhone 15 Pro' },
      ip: '1.2.3.4',
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

  it('X-Forwarded-For forjado NÃO vira o IP: vale req.ip/socket, XFF fica só como pista', () => {
    const c = extrairClienteInfo({
      headers: { 'x-forwarded-for': '6.6.6.6, 10.0.0.1' },
      ip: '200.1.2.3',
      socket: { remoteAddress: '::ffff:127.0.0.1' },
    });
    expect(c.ip).toBe('200.1.2.3');
    expect(c.ipSocket).toBe('127.0.0.1');
    expect(c.xff).toBe('6.6.6.6, 10.0.0.1');
  });

  it('sem req.ip cai no socket; lixo no lugar de IP vira null', () => {
    expect(extrairClienteInfo({ headers: {}, socket: { remoteAddress: '9.9.9.9' } }).ip).toBe('9.9.9.9');
    expect(extrairClienteInfo({ headers: {}, ip: "1.1.1.1'; DROP TABLE x" }).ip).toBeNull();
  });

  it('user-agent e headers: corta no tamanho e tira caracteres de controle', () => {
    const c = extrairClienteInfo({
      headers: {
        'user-agent': 'Evil\r\nX-Injected: 1\u0000' + 'A'.repeat(1000),
        'x-client-device': 'Pixel\n7',
        'x-forwarded-for': '1.1.1.1\r\nfake',
      },
      ip: '8.8.8.8',
    });
    expect(c.userAgent!.length).toBeLessThanOrEqual(255);
    expect(c.userAgent).not.toContain('\r');
    expect(c.userAgent).not.toContain('\n');
    expect(c.userAgent).not.toContain('\u0000');
    expect(c.aparelho).toBe('Pixel 7');
    expect(c.xff).toBe('1.1.1.1 fake');
  });

  describe("com trust proxy = 'loopback' (como no main.ts)", () => {
    let server: http.Server;
    let porta: number;

    beforeAll(async () => {
      const app = express();
      app.set('trust proxy', 'loopback');
      app.get('/', (req: any, res: any) => res.json(extrairClienteInfo(req as any)));
      server = app.listen(0, '127.0.0.1');
      await new Promise((ok) => server.once('listening', ok));
      porta = (server.address() as AddressInfo).port;
    });
    afterAll(() => new Promise((ok) => server.close(ok)));

    const pedir = (xff: string) =>
      new Promise<any>((ok, erro) => {
        http
          .get({ host: '127.0.0.1', port: porta, path: '/', headers: { 'x-forwarded-for': xff } }, (res) => {
            let b = '';
            res.on('data', (d) => (b += d));
            res.on('end', () => ok(JSON.parse(b)));
          })
          .on('error', erro);
      });

    it('cliente forja XFF; o nginx (loopback) anexa o IP real; a trilha usa o real', async () => {
      // nginx: X-Forwarded-For = <o que o cliente mandou>, $remote_addr
      const c = await pedir('6.6.6.6, 200.10.20.30');
      expect(c.ip).toBe('200.10.20.30');
      expect(c.ipSocket).toBe('127.0.0.1');
      expect(c.xff).toBe('6.6.6.6, 200.10.20.30');
    });
  });
});
