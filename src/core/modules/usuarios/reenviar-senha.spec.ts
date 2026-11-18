import { BadRequestException, NotFoundException } from '@nestjs/common';
import { UsuariosService } from './usuarios.service';
import { gerarSenhaTemporaria } from './senha-temporaria';

jest.mock('bcryptjs', () => ({ hash: jest.fn().mockResolvedValue('hash-novo'), compare: jest.fn() }));
jest.mock('nanoid', () => ({ customAlphabet: jest.fn(() => jest.fn(() => 'x')) }));

describe('NEXON-129 — reenviar senha por e-mail', () => {
  const usuario = { id: 'u1', nome: 'Diego', email: 'diego@exemplo.com', status: 'Ativo', is_active: true, role: 'proprietario' };
  let prisma: any;
  let mail: any;
  let auditoria: any;
  let service: UsuariosService;

  beforeEach(() => {
    prisma = { usuarios: { findFirst: jest.fn().mockResolvedValue(usuario), update: jest.fn() } };
    mail = { sendSenhaReenviadaEmail: jest.fn().mockResolvedValue({ enviado: true }) };
    auditoria = { registrar: jest.fn() };
    service = new UsuariosService(prisma, {} as any, {} as any, mail, auditoria);
    jest.spyOn(service as any, 'assertPodeGerir').mockResolvedValue(undefined);
    jest.spyOn(service, 'marcarSenhaAlterada').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'revogarSessoes').mockResolvedValue(undefined);
  });

  it('envia o e-mail, troca a senha, derruba sessões e audita', async () => {
    const r = await service.reenviarSenhaPorEmail('u1', { id: 'adm', nome: 'Admin' } as any);
    expect(r.email).toBe('diego@exemplo.com');
    const senhaEnviada = mail.sendSenhaReenviadaEmail.mock.calls[0][2];
    expect(senhaEnviada).toHaveLength(10);
    expect(prisma.usuarios.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ senha: 'hash-novo' }) }));
    expect((service as any).revogarSessoes).toHaveBeenCalledWith('u1', null);
    expect(auditoria.registrar).toHaveBeenCalledWith(expect.objectContaining({
      acao: 'senha_reenviada', autorId: 'adm', alvoUsuarioId: 'u1',
      detalhes: expect.objectContaining({ enviado: true, email_destino: 'diego@exemplo.com' }),
    }));
  });

  it('falha no SMTP mantém a senha atual e audita a falha', async () => {
    mail.sendSenhaReenviadaEmail.mockResolvedValue({ enviado: false, erro: 'timeout' });
    await expect(service.reenviarSenhaPorEmail('u1', {} as any)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.usuarios.update).not.toHaveBeenCalled();
    expect(auditoria.registrar).toHaveBeenCalledWith(expect.objectContaining({
      acao: 'senha_reenviada', detalhes: expect.objectContaining({ enviado: false, erro: 'timeout' }),
    }));
  });

  it('recusa usuário sem e-mail, inativo ou inexistente', async () => {
    prisma.usuarios.findFirst.mockResolvedValueOnce({ ...usuario, email: '' });
    await expect(service.reenviarSenhaPorEmail('u1')).rejects.toBeInstanceOf(BadRequestException);
    prisma.usuarios.findFirst.mockResolvedValueOnce({ ...usuario, status: 'Inativo' });
    await expect(service.reenviarSenhaPorEmail('u1')).rejects.toBeInstanceOf(BadRequestException);
    prisma.usuarios.findFirst.mockResolvedValueOnce(null);
    await expect(service.reenviarSenhaPorEmail('u1')).rejects.toBeInstanceOf(NotFoundException);
    expect(mail.sendSenhaReenviadaEmail).not.toHaveBeenCalled();
  });

  it('senha temporária tem 10 caracteres, dígitos e nada ambíguo', () => {
    for (let i = 0; i < 200; i++) {
      const s = gerarSenhaTemporaria();
      expect(s).toHaveLength(10);
      expect(s.replace(/\D/g, '').length).toBeGreaterThanOrEqual(2);
      expect(s).not.toMatch(/[0O1lI]/);
    }
  });
});
