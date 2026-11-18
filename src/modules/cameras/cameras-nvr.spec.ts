import { canaisDoModelo, descobertasPendentes, ehGravador } from './cameras-regras';

describe('gravador (NVR) Intelbras/Dahua', () => {
  it('reconhece NVR/XVR/DVR pelo modelo e não confunde câmera', () => {
    for (const m of ['NVD 1404', 'DHI-NVR4108HS-4KS2', 'MHDX 1108', 'iNVD 3116', 'XVR5104HS', 'NVR5216-16P']) expect(ehGravador(m)).toBe(true);
    for (const m of ['VIP 1230 B G4', 'IPC-HFW1230S', 'VIP 3230 D SL', null, '']) expect(ehGravador(m)).toBe(false);
  });

  it('sugere os canais pelo número do modelo', () => {
    expect(canaisDoModelo('NVD 1404')).toBe(4);
    expect(canaisDoModelo('DHI-NVR4108HS')).toBe(8);
    expect(canaisDoModelo('NVR5216-16P')).toBe(16);
    expect(canaisDoModelo('NVD 3132')).toBe(32);
    expect(canaisDoModelo('NVR')).toBeNull();
  });

  it('gravador continua na lista de encontradas mesmo com canal cadastrado; câmera some', () => {
    const agora = new Date();
    const lista = descobertasPendentes(
      [
        { ip: '192.168.1.30', modelo: 'NVD 1404', visto_em: agora },
        { ip: '192.168.1.40', modelo: 'VIP 1230', visto_em: agora },
      ],
      ['192.168.1.30', '192.168.1.40'],
      agora,
    );
    expect(lista.map((d) => d.ip)).toEqual(['192.168.1.30']);
  });
});
