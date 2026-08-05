/**
 * E2E tests contra servidor vivo (nexon-api em localhost:3001).
 *
 * Por que nao spawnar o AppModule no Jest:
 * - AppModule sobe MQTT + Redis + Sentry + WebSocket; ~10s de setup por suite.
 * - Servidor de dev (pnpm start:dev) ja faz hot reload.
 * - Garante teste mais real (passa pelo nginx local, validation pipe global,
 *   response interceptor, http exception filter — todos configurados no main.ts).
 *
 * Pre-requisito: nexon-api rodando em localhost:3001 (pnpm start:dev).
 * Se ele estiver offline, todos os testes falham com ECONNREFUSED.
 *
 * Por isso esta suite NAO roda no `pnpm test` padrao: ela e excluida via
 * testPathIgnorePatterns e tem script proprio, `pnpm test:e2e:live`. Antes
 * dessa separacao, `pnpm test` vinha vermelho por padrao com 14 falhas de
 * conexao, o que escondia regressao de verdade no meio do ruido.
 *
 * Cleanup: entries criadas tem prefixo "e2e_test_" no codigo do tipo OU no
 * fabricante do modelo. Removidas em beforeAll + afterAll pra nao acumular.
 */
import * as request from 'supertest';

const BASE_URL = 'http://localhost:3001';
const API = '/api/v1/iot-catalog';

const ADMIN_EMAIL = 'admin@email.com';
const ADMIN_SENHA = 'Aupus123!';
const E2E_PREFIX = 'e2e_test_';
const E2E_FABRICANTE = 'E2E_TEST_VENDOR';

let token: string;
let createdTipoIds: string[] = [];
let createdModeloIds: string[] = [];

async function login(): Promise<string> {
  const res = await request(BASE_URL).post('/api/v1/auth/login').send({
    email: ADMIN_EMAIL,
    senha: ADMIN_SENHA,
  });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`Login falhou: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.data.access_token;
}

async function cleanup(authToken: string) {
  // Deleta TODAS as entries com prefixo (de runs anteriores tambem).
  const tipos = await request(BASE_URL)
    .get(`${API}/tipos`)
    .set('Authorization', `Bearer ${authToken}`);
  const modelos = await request(BASE_URL)
    .get(`${API}/modelos`)
    .set('Authorization', `Bearer ${authToken}`);

  for (const m of modelos.body?.data ?? modelos.body ?? []) {
    if (m.fabricante === E2E_FABRICANTE) {
      await request(BASE_URL)
        .delete(`${API}/modelos/${m.id}`)
        .set('Authorization', `Bearer ${authToken}`);
    }
  }
  for (const t of tipos.body?.data ?? tipos.body ?? []) {
    if (t.codigo?.startsWith(E2E_PREFIX)) {
      await request(BASE_URL)
        .delete(`${API}/tipos/${t.id}`)
        .set('Authorization', `Bearer ${authToken}`);
    }
  }
}

describe('IotCatalog E2E (live server)', () => {
  beforeAll(async () => {
    token = await login();
    await cleanup(token);
  }, 30000);

  afterAll(async () => {
    if (token) await cleanup(token);
  }, 30000);

  // ============================================================================
  // 1-2: device-catalog.js (publico + ETag)
  // ============================================================================

  describe('GET /device-catalog.js', () => {
    it('1. retorna 200 com JS e ETag presente', async () => {
      const res = await request(BASE_URL).get(`${API}/device-catalog.js`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/javascript');
      expect(res.headers.etag).toMatch(/^"\d+-\d+"$/);
      expect(res.text).toContain('var DEVICE_POINTS');
      expect(res.text).toContain('var DEVICE_MODELS');
      expect(res.text).toContain('function getCatalogDevice');
    });

    it('2. retorna 304 quando If-None-Match bate', async () => {
      const first = await request(BASE_URL).get(`${API}/device-catalog.js`);
      const etag = first.headers.etag;
      expect(etag).toBeDefined();

      const second = await request(BASE_URL)
        .get(`${API}/device-catalog.js`)
        .set('If-None-Match', etag);
      expect(second.status).toBe(304);
    });
  });

  // ============================================================================
  // 3-4: GET tipos (auth)
  // ============================================================================

  describe('GET /tipos', () => {
    it('3. retorna 401 sem JWT', async () => {
      const res = await request(BASE_URL).get(`${API}/tipos`);
      expect(res.status).toBe(401);
    });

    it('4. retorna 200 com JWT admin', async () => {
      const res = await request(BASE_URL)
        .get(`${API}/tipos`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      const data = res.body.data ?? res.body;
      expect(Array.isArray(data)).toBe(true);
    });
  });

  // ============================================================================
  // 5-7: POST tipos (criar / codigo invalido / duplicado)
  // ============================================================================

  describe('POST /tipos', () => {
    it('5. cria tipo valido (201)', async () => {
      const codigo = `${E2E_PREFIX}simples`;
      const res = await request(BASE_URL)
        .post(`${API}/tipos`)
        .set('Authorization', `Bearer ${token}`)
        .send({ codigo, nome: 'Tipo E2E Simples' });

      expect([200, 201]).toContain(res.status);
      const data = res.body.data ?? res.body;
      expect(data.codigo).toBe(codigo);
      expect(data.nome).toBe('Tipo E2E Simples');
      expect(data.pontos).toEqual({ ai: [], bi: [], bo: [] });
      createdTipoIds.push(data.id);
    });

    it('6. rejeita 400 quando codigo nao eh snake_case', async () => {
      const res = await request(BASE_URL)
        .post(`${API}/tipos`)
        .set('Authorization', `Bearer ${token}`)
        .send({ codigo: 'Bad-Code', nome: 'Bad' });

      expect(res.status).toBe(400);
      // O exceptionFactory custom do main.ts loga detalhes nos logs mas expoe
      // apenas "Validation failed" no response (interceptor remove `errors`).
      // Suficiente: a request foi rejeitada com 400.
      const msg = JSON.stringify(res.body);
      expect(msg.toLowerCase()).toContain('validation failed');
    });

    it('7. rejeita 409 em codigo duplicado', async () => {
      const codigo = `${E2E_PREFIX}duplicado`;
      const first = await request(BASE_URL)
        .post(`${API}/tipos`)
        .set('Authorization', `Bearer ${token}`)
        .send({ codigo, nome: 'Primeiro' });
      const firstData = first.body.data ?? first.body;
      createdTipoIds.push(firstData.id);

      const second = await request(BASE_URL)
        .post(`${API}/tipos`)
        .set('Authorization', `Bearer ${token}`)
        .send({ codigo, nome: 'Segundo' });
      expect(second.status).toBe(409);
    });
  });

  // ============================================================================
  // 8-10: POST modelos (criar / tipo inexistente / mapping invalido)
  // ============================================================================

  describe('POST /modelos', () => {
    let tipoCodigo: string;

    beforeAll(async () => {
      tipoCodigo = `${E2E_PREFIX}modelos`;
      const res = await request(BASE_URL)
        .post(`${API}/tipos`)
        .set('Authorization', `Bearer ${token}`)
        .send({ codigo: tipoCodigo, nome: 'Tipo para modelos E2E' });
      const data = res.body.data ?? res.body;
      createdTipoIds.push(data.id);
    });

    it('8. cria modelo valido (201)', async () => {
      const res = await request(BASE_URL)
        .post(`${API}/modelos`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          tipo: tipoCodigo,
          fabricante: E2E_FABRICANTE,
          modelo: 'X-1',
          protocolo: 'rtu',
        });
      expect([200, 201]).toContain(res.status);
      const data = res.body.data ?? res.body;
      expect(data.fabricante).toBe(E2E_FABRICANTE);
      expect(data.modelo).toBe('X-1');
      // catalog_id derivado dentro de mapeamento (slug remove underscore)
      expect(data.mapeamento.catalog_id).toBe('e2etestvendor-x-1');
      createdModeloIds.push(data.id);
    });

    it('9. retorna 404 quando tipo nao existe', async () => {
      const res = await request(BASE_URL)
        .post(`${API}/modelos`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          tipo: 'tipo_inexistente_xyz',
          fabricante: E2E_FABRICANTE,
          modelo: 'Y-1',
          protocolo: 'rtu',
        });
      expect(res.status).toBe(404);
    });

    it('10. rejeita 400 quando mapeamento.ai_map.X.dataType eh invalido', async () => {
      const res = await request(BASE_URL)
        .post(`${API}/modelos`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          tipo: tipoCodigo,
          fabricante: E2E_FABRICANTE,
          modelo: 'Y-bad',
          protocolo: 'rtu',
          mapeamento: {
            ai_blocks: [{ start: 0, count: 10, func: 0x03 }],
            ai_map: { foo: { block: 0, offset: 5, dataType: 'FLOAT64' } },
          },
        });
      expect(res.status).toBe(400);
      const msg = JSON.stringify(res.body);
      expect(msg).toContain('Mapeamento invalido');
      // Mensagem cita o path do ponto que falhou (admin descobre onde corrigir)
      expect(msg).toContain('ai_map.foo.dataType');
    });
  });

  // ============================================================================
  // 11: PATCH modelo
  // ============================================================================

  describe('PATCH /modelos/:id', () => {
    it('11. atualiza protocolo + connection_note', async () => {
      // Cria modelo
      const tipoCodigo = `${E2E_PREFIX}patch`;
      const tipoRes = await request(BASE_URL)
        .post(`${API}/tipos`)
        .set('Authorization', `Bearer ${token}`)
        .send({ codigo: tipoCodigo, nome: 'PatchTest' });
      const tipoData = tipoRes.body.data ?? tipoRes.body;
      createdTipoIds.push(tipoData.id);

      const createRes = await request(BASE_URL)
        .post(`${API}/modelos`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          tipo: tipoCodigo,
          fabricante: E2E_FABRICANTE,
          modelo: 'PatchMe',
          protocolo: 'rtu',
        });
      const createData = createRes.body.data ?? createRes.body;
      createdModeloIds.push(createData.id);

      const patchRes = await request(BASE_URL)
        .patch(`${API}/modelos/${createData.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ protocolo: 'tcp', connection_note: 'Via gateway WiNet-S' });

      expect(patchRes.status).toBe(200);
      const patchData = patchRes.body.data ?? patchRes.body;
      expect(patchData.protocolo).toBe('tcp');
      expect(patchData.connection_note).toBe('Via gateway WiNet-S');
      // catalog_id preservado (slug remove underscore)
      expect(patchData.mapeamento.catalog_id).toBe('e2etestvendor-patchme');
    });
  });

  // ============================================================================
  // 12: DELETE tipo cascade modelos
  // ============================================================================

  describe('DELETE /tipos/:id cascade', () => {
    it('12. ao deletar tipo, modelos linkados sao deletados em cascata', async () => {
      const tipoCodigo = `${E2E_PREFIX}cascade`;
      const tipoRes = await request(BASE_URL)
        .post(`${API}/tipos`)
        .set('Authorization', `Bearer ${token}`)
        .send({ codigo: tipoCodigo, nome: 'CascadeTest' });
      const tipoData = tipoRes.body.data ?? tipoRes.body;

      const modeloRes = await request(BASE_URL)
        .post(`${API}/modelos`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          tipo: tipoCodigo,
          fabricante: E2E_FABRICANTE,
          modelo: 'WillDie',
          protocolo: 'rtu',
        });
      const modeloData = modeloRes.body.data ?? modeloRes.body;

      // Confirma que existe
      const before = await request(BASE_URL)
        .get(`${API}/modelos/${modeloData.id}`)
        .set('Authorization', `Bearer ${token}`);
      expect(before.status).toBe(200);

      // Deleta tipo
      const deleteRes = await request(BASE_URL)
        .delete(`${API}/tipos/${tipoData.id}`)
        .set('Authorization', `Bearer ${token}`);
      expect([200, 204]).toContain(deleteRes.status);

      // Modelo deve ter sido deletado em cascata
      const after = await request(BASE_URL)
        .get(`${API}/modelos/${modeloData.id}`)
        .set('Authorization', `Bearer ${token}`);
      expect(after.status).toBe(404);
    });
  });

  // ============================================================================
  // 13: POST duplicate
  // ============================================================================

  describe('POST /modelos/:id/duplicate', () => {
    it('13. duplica criando entry com sufixo "(copia)"', async () => {
      const tipoCodigo = `${E2E_PREFIX}dup`;
      const tipoRes = await request(BASE_URL)
        .post(`${API}/tipos`)
        .set('Authorization', `Bearer ${token}`)
        .send({ codigo: tipoCodigo, nome: 'DupTest' });
      const tipoData = tipoRes.body.data ?? tipoRes.body;
      createdTipoIds.push(tipoData.id);

      const createRes = await request(BASE_URL)
        .post(`${API}/modelos`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          tipo: tipoCodigo,
          fabricante: E2E_FABRICANTE,
          modelo: 'Orig',
          protocolo: 'rtu',
        });
      const orig = createRes.body.data ?? createRes.body;
      createdModeloIds.push(orig.id);

      const dupRes = await request(BASE_URL)
        .post(`${API}/modelos/${orig.id}/duplicate`)
        .set('Authorization', `Bearer ${token}`);
      expect([200, 201]).toContain(dupRes.status);
      const dup = dupRes.body.data ?? dupRes.body;
      expect(dup.modelo).toBe('Orig (copia)');
      expect(dup.fabricante).toBe(E2E_FABRICANTE);
      createdModeloIds.push(dup.id);
    });
  });

  // ============================================================================
  // 14: ETag muda apos criar modelo (sanity de invalidacao do cache)
  // ============================================================================

  describe('ETag de device-catalog.js', () => {
    it('14. muda apos criar modelo novo', async () => {
      const before = await request(BASE_URL).get(`${API}/device-catalog.js`);
      const etagBefore = before.headers.etag;
      expect(etagBefore).toBeDefined();

      const tipoCodigo = `${E2E_PREFIX}etag`;
      const tipoRes = await request(BASE_URL)
        .post(`${API}/tipos`)
        .set('Authorization', `Bearer ${token}`)
        .send({ codigo: tipoCodigo, nome: 'EtagTest' });
      const tipoData = tipoRes.body.data ?? tipoRes.body;
      createdTipoIds.push(tipoData.id);

      const modeloRes = await request(BASE_URL)
        .post(`${API}/modelos`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          tipo: tipoCodigo,
          fabricante: E2E_FABRICANTE,
          modelo: 'Etag-1',
          protocolo: 'rtu',
        });
      const modeloData = modeloRes.body.data ?? modeloRes.body;
      createdModeloIds.push(modeloData.id);

      const after = await request(BASE_URL).get(`${API}/device-catalog.js`);
      const etagAfter = after.headers.etag;
      expect(etagAfter).toBeDefined();
      expect(etagAfter).not.toBe(etagBefore);
    });
  });
});
