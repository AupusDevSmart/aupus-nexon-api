import { baseOcpp, decidirConexao, EstacaoOcpp, gerarChave, hashChave, identidadeParaLog, identidadeValida, respostaRecusa, urlsDeConexao } from './ocpp-conexao';

/** NEXON-130 — quem pode abrir o WebSocket do carregador: só o cadastrado e com a chave. */
const CHAVE_A = 'aaaabbbbccccdddd0000111122223333';
const CHAVE_B = '99998888777766665555444433332222';
const A: EstacaoOcpp = { id: 'e1', chargePointId: '20260703000025', equipamentoId: 'car-1', plantaId: 'pl-1', conector: 1, chaveHash: hashChave(CHAVE_A) };
const B: EstacaoOcpp = { id: 'e2', chargePointId: 'WALLBOX-B', equipamentoId: 'car-2', plantaId: 'pl-2', conector: 1, chaveHash: hashChave(CHAVE_B) };
const todas = [A, B];
const basic = (usuario: string, senha: string | Buffer) =>
  `Basic ${Buffer.concat([Buffer.from(`${usuario}:`), Buffer.isBuffer(senha) ? senha : Buffer.from(senha)]).toString('base64')}`;
const pedir = (url: string, extra: { authorization?: string; protocolos?: string } = {}) =>
  decidirConexao({ url, protocolos: 'ocpp1.6', ...extra }, todas);

describe('Conexão do carregador na central OCPP', () => {
  it('chave na URL: /ocpp/<chave>/<identidade>', () => {
    expect(pedir(`/ocpp/${CHAVE_A}/20260703000025`)).toEqual({ ok: true, estacao: A, via: 'url' });
    expect(pedir(`/ocpp/${CHAVE_A.toUpperCase()}/20260703000025/`)).toMatchObject({ ok: true });
    expect(pedir(`/ocpp/${CHAVE_B}/wallbox-b?x=1`)).toMatchObject({ ok: true, estacao: B });
  });

  it('só a chave na URL (carregador que não acrescenta a identidade): entra, e a chave não vira identidade', () => {
    expect(pedir(`/ocpp/${CHAVE_B}`)).toEqual({ ok: true, estacao: B, via: 'url' });
    const semProtocolo = decidirConexao({ url: `/ocpp/${CHAVE_B}` }, todas);
    expect(semProtocolo).toMatchObject({ ok: false, http: 400, identidade: 'WALLBOX-B' });
    expect(JSON.stringify(semProtocolo)).not.toContain(CHAVE_B);
  });

  it('ordem trocada (/ocpp/<identidade>/<chave>): entra do mesmo jeito', () => {
    expect(pedir(`/ocpp/20260703000025/${CHAVE_A}`)).toEqual({ ok: true, estacao: A, via: 'url' });
    expect(pedir(`/ocpp/WALLBOX-B/${CHAVE_A}`)).toMatchObject({ ok: false, http: 403, identidade: 'WALLBOX-B' });
  });

  it('a chave nunca vira "identidade" de log: nem errada por um dígito, nem em ordem trocada', () => {
    const quase = `${CHAVE_A.slice(0, 31)}0`;
    for (const url of [`/ocpp/${quase}`, `/ocpp/20260703000025/${quase}`, `/ocpp/DESCONHECIDO/${quase}`]) {
      const d = pedir(url);
      expect(d.ok).toBe(false);
      expect(JSON.stringify(d)).not.toContain(quase);
      expect((d as any).identidade).toBe('(parece uma chave)');
    }
    // chave errada na posição certa: a identidade registrada é a identidade, não a chave
    expect(pedir(`/ocpp/${quase}/20260703000025`)).toMatchObject({ http: 401, identidade: '20260703000025' });
    // quebra de linha na URL não forja linha de log
    expect((pedir('/ocpp/CP%0A%5BOCPP%5D%20falso') as any).identidade).toBe('CP?[OCPP] falso');
    expect(identidadeParaLog('x'.repeat(200))).toHaveLength(64);
  });

  it('HTTP Basic: senha como texto ou como os bytes da chave', () => {
    expect(pedir('/ocpp/20260703000025', { authorization: basic('20260703000025', CHAVE_A) })).toEqual({ ok: true, estacao: A, via: 'basic' });
    expect(pedir('/ocpp/20260703000025', { authorization: basic('20260703000025', Buffer.from(CHAVE_A, 'hex')) })).toMatchObject({ ok: true });
  });

  it('sem chave ou com chave errada: 401', () => {
    expect(pedir('/ocpp/20260703000025')).toMatchObject({ ok: false, http: 401, motivo: 'Sem chave de conexão', identidade: '20260703000025' });
    expect(pedir('/ocpp/00000000000000000000000000000000/20260703000025')).toMatchObject({ ok: false, http: 401, motivo: 'Chave de conexão incorreta' });
    expect(pedir('/ocpp/20260703000025', { authorization: basic('20260703000025', 'errada') })).toMatchObject({ ok: false, http: 401 });
    expect(pedir('/ocpp/20260703000025', { authorization: 'Bearer x' })).toMatchObject({ ok: false, http: 401 });
  });

  it('identidade não cadastrada: 404, com ou sem chave', () => {
    expect(pedir('/ocpp/DESCONHECIDO')).toMatchObject({ ok: false, http: 404, motivo: 'Carregador não cadastrado', identidade: 'DESCONHECIDO' });
    expect(pedir('/ocpp/00000000000000000000000000000000/DESCONHECIDO')).toMatchObject({ ok: false, http: 404 });
  });

  it('chave de um carregador com a identidade de outro: 403 e a dica da identidade cadastrada', () => {
    const d = pedir(`/ocpp/${CHAVE_A}/WALLBOX-B`);
    expect(d).toMatchObject({ ok: false, http: 403, identidade: 'WALLBOX-B' });
    expect((d as any).motivo).toContain('20260703000025');
    // identidade que o carregador manda e ninguém cadastrou: a chave diz de quem é
    expect(pedir(`/ocpp/${CHAVE_A}/SERIE-REAL`)).toMatchObject({ ok: false, http: 403 });
  });

  it('exige o subprotocolo ocpp1.6', () => {
    expect(decidirConexao({ url: `/ocpp/${CHAVE_A}/20260703000025` }, todas)).toMatchObject({ ok: false, http: 400 });
    expect(decidirConexao({ url: `/ocpp/${CHAVE_A}/20260703000025`, protocolos: 'ocpp2.0.1' }, todas)).toMatchObject({ ok: false, http: 400 });
    expect(decidirConexao({ url: `/ocpp/${CHAVE_A}/20260703000025`, protocolos: 'ocpp2.0.1, ocpp1.6' }, todas)).toMatchObject({ ok: true });
  });

  it('endereço torto: 400', () => {
    expect(pedir('/ocpp/')).toMatchObject({ ok: false, http: 400 });
    expect(pedir('/ocpp/a/b/c')).toMatchObject({ ok: false, http: 400 });
    expect(pedir('/ocpp/%E0%A4%A/x')).toMatchObject({ ok: false, http: 400 });
  });

  it('carregador cadastrado sem chave não entra', () => {
    const semChave = { ...A, chaveHash: null };
    expect(decidirConexao({ url: `/ocpp/${CHAVE_A}/20260703000025`, protocolos: 'ocpp1.6' }, [semChave])).toMatchObject({ ok: false, http: 401 });
  });

  it('chave gerada tem 16 bytes e o banco só guarda o hash', () => {
    const c = gerarChave();
    expect(c).toMatch(/^[0-9a-f]{32}$/);
    expect(hashChave(c)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashChave(c)).not.toContain(c);
    expect(hashChave(c.toUpperCase())).toBe(hashChave(c));
  });

  it('identidade do cadastro, URLs e resposta de recusa', () => {
    expect(identidadeValida(' 20260703000025 ')).toBe('20260703000025');
    expect(identidadeValida('com espaço')).toBeNull();
    expect(identidadeValida('a/b')).toBeNull();
    expect(identidadeValida('')).toBeNull();
    expect(baseOcpp('https://aupus-nexon-api.aupusenergia.com.br/')).toBe('wss://aupus-nexon-api.aupusenergia.com.br/ocpp');
    expect(baseOcpp('http://localhost:3001/api/v1')).toBe('ws://localhost:3001/ocpp');
    expect(baseOcpp(undefined)).toBe('wss://aupus-nexon-api.aupusenergia.com.br/ocpp');
    expect(urlsDeConexao('wss://h/ocpp', 'abc', 'CP 1')).toEqual({ url: 'wss://h/ocpp/abc', url_completa: 'wss://h/ocpp/abc/CP%201' });
    expect(respostaRecusa(401)).toContain('WWW-Authenticate: Basic');
    expect(respostaRecusa(404)).toMatch(/^HTTP\/1\.1 404 Not Found\r\n/);
  });
});
