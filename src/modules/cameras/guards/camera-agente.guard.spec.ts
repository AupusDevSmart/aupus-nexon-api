import { UnauthorizedException } from '@nestjs/common';
import { CameraAgenteGuard } from './camera-agente.guard';

const agente = { id: 'ag1', unidade_id: 'u1', planta_id: 'p1', nome: 'Agente SSU' };

function montar(headers: Record<string, string>) {
  const req: any = { headers, ip: '10.0.0.7' };
  const ctx: any = { switchToHttp: () => ({ getRequest: () => req }) };
  const midia: any = {
    agentePorToken: jest.fn().mockImplementation(async (token: string) => (token === 'nxcam_valido' ? agente : null)),
  };
  return { guard: new CameraAgenteGuard(midia), ctx, req, midia };
}

describe('CameraAgenteGuard', () => {
  it('sem Authorization → 401 e nem consulta o banco', async () => {
    const { guard, ctx, midia } = montar({});
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(midia.agentePorToken).not.toHaveBeenCalled();
  });

  it('header fora do formato Bearer → 401', async () => {
    const { guard, ctx } = montar({ authorization: 'Basic abc' });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('token desconhecido → 401', async () => {
    const { guard, ctx, req } = montar({ authorization: 'Bearer nxcam_outro' });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(req.agente).toBeUndefined();
  });

  it('token válido → req.agente com ids sem padding', async () => {
    const { guard, ctx, req, midia } = montar({ authorization: 'bearer  nxcam_valido ' });
    expect(await guard.canActivate(ctx)).toBe(true);
    expect(midia.agentePorToken).toHaveBeenCalledWith('nxcam_valido');
    expect(req.agente).toEqual(agente);
  });
});
