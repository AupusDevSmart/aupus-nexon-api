import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CamerasInstaladorService } from './cameras-instalador.service';

/* eslint-disable @typescript-eslint/no-explicit-any */
const sha = 'b'.repeat(64);
function montar(publicado = true) {
  const dir = mkdtempSync(join(tmpdir(), 'nexon-inst-'));
  if (publicado) {
    mkdirSync(join(dir, 'instalador'));
    writeFileSync(join(dir, 'instalador', 'atual.json'), JSON.stringify({ versao: '2026.11.17', arquivo: 'nexon-cam-pi5.img.gz', sha256: sha, tamanho: 10 }));
    writeFileSync(join(dir, 'instalador', 'instalar-pelo-pc.sh'), 'URL="${X:-__NEXON_IMAGEM_URL__}"\nSHA="${Y:-__NEXON_IMAGEM_SHA__}"\n');
  }
  const storage: any = { absoluto: (rel: string) => join(dir, rel), servir: jest.fn() };
  const midia: any = { gerarTokenMidia: () => ({ token: 'tk.1', valido_ate: 'x' }) };
  const auditoria: any = { registrar: jest.fn() };
  return { svc: new CamerasInstaladorService(storage, midia, auditoria), auditoria, storage };
}
const req: any = { headers: { 'x-forwarded-proto': 'https' }, protocol: 'http', get: () => 'api.exemplo', query: { token: 'tk.1' } };
const admin: any = { id: 'a', role: 'super_admin' };

describe('instalador do Raspberry', () => {
  it('devolve comando do Terminal com token e audita', async () => {
    const m = montar();
    const r = await m.svc.info(admin, req);
    expect(r.comando).toBe("curl -fsSL 'https://api.exemplo/api/v1/cameras/instalador/script?token=tk.1' | bash");
    expect(m.auditoria.registrar.mock.calls[0][0]).toBe('camera_instalador');
  });

  it('script sai com URL da imagem e sha256 no lugar dos marcadores', async () => {
    const m = montar();
    const res: any = { setHeader: jest.fn(), send: jest.fn() };
    await m.svc.script(admin, req, res);
    const texto = res.send.mock.calls[0][0];
    expect(texto).toContain('https://api.exemplo/api/v1/cameras/instalador/imagem?token=tk.1');
    expect(texto).toContain(sha);
    expect(texto).not.toContain('__NEXON_');
  });

  it('sem permissão ou sem publicação recusa', async () => {
    await expect(montar().svc.info({ id: 'x', role: 'operador' } as any, req)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(montar(false).svc.info(admin, req)).rejects.toBeInstanceOf(NotFoundException);
  });
});
