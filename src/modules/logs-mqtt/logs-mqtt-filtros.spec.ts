import { colunaTrilhaAusente, condicaoStatus, juntarE, parseTipos } from './logs-mqtt-filtros';

describe('logs-mqtt-filtros', () => {
  describe('parseTipos', () => {
    it('csv → lista válida, sem repetição', () => {
      expect(parseTipos('comando,acesso')).toEqual(['comando', 'acesso']);
      expect(parseTipos(' Alerta , alerta ')).toEqual(['alerta']);
    });
    it('vazio ou só lixo → null (todos os de logs_mqtt)', () => {
      expect(parseTipos(undefined)).toBeNull();
      expect(parseTipos('')).toBeNull();
      expect(parseTipos('xyz')).toBeNull();
    });
  });

  describe('condicaoStatus', () => {
    const agora = new Date('2026-09-28T12:00:00Z');

    it('ativo = alerta sem reconhecimento/resolução e NÃO silenciado, dentro da janela', () => {
      const c = condicaoStatus('ativo', agora, 7);
      expect(c.sql).toContain(`l.tipo = 'alerta'`);
      expect(c.sql).toContain('l.reconhecido_em IS NULL');
      expect(c.sql).toContain('l.resolvido_em IS NULL');
      expect(c.sql).toContain('l.silenciado_ate IS NULL OR l.silenciado_ate <= now()');
      expect(c.sql).toContain('l.created_at >=');
      expect(c.values).toEqual([new Date('2026-09-21T12:00:00Z')]);
    });

    it('ativo sem janela (0 dias) não filtra por data', () => {
      const c = condicaoStatus('ativo', agora, 0);
      expect(c.sql).not.toContain('created_at');
      expect(c.values).toEqual([]);
    });

    it('reconhecido exclui resolvido; resolvido é só resolvido', () => {
      const r = condicaoStatus('reconhecido', agora);
      expect(r.sql).toContain('l.reconhecido_em IS NOT NULL');
      expect(r.sql).toContain('l.resolvido_em IS NULL');
      expect(r.sql).not.toContain('silenciado');
      const s = condicaoStatus('resolvido', agora);
      expect(s.sql).toContain('l.resolvido_em IS NOT NULL');
      expect(s.sql).toContain(`l.tipo = 'alerta'`);
    });
  });

  it('juntarE: vazio → TRUE', () => {
    expect(juntarE([]).sql).toBe('TRUE');
  });

  it('colunaTrilhaAusente reconhece coluna/tabela inexistente', () => {
    expect(colunaTrilhaAusente({ code: 'P2010', meta: { code: '42703' } })).toBe(true);
    expect(colunaTrilhaAusente({ message: 'relation "auditoria_acessos" does not exist' })).toBe(true);
    expect(colunaTrilhaAusente({ message: 'column l.dispositivo does not exist' })).toBe(true);
    expect(colunaTrilhaAusente(new Error('timeout'))).toBe(false);
    expect(colunaTrilhaAusente(null)).toBe(false);
  });
});
