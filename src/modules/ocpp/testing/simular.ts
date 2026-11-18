import { CarregadorSimulado } from './carregador-simulado';

/**
 * Ensaio manual: um carregador OCPP 1.6-J simulado contra a API (local ou de homologação).
 * Serve para ver a tela do carregador funcionar sem o equipamento.
 *
 *   npx ts-node -r tsconfig-paths/register src/modules/ocpp/testing/simular.ts ws://localhost:3001/ocpp/<chave>/<identidade>
 *
 * Conecta, fica livre e espera. Quando alguém inicia a recarga no NexON (ou com `--cartao
 * <tag>` aqui), mede ~7,2 kW a cada 5 s; para quando o NexON manda parar. Ctrl+C encerra.
 * NÃO aponte para a identidade de um carregador de verdade em uso.
 */
async function main() {
  const [url, ...resto] = process.argv.slice(2);
  if (!url) {
    console.error('uso: simular.ts ws(s)://host/ocpp/<chave>/<identidade> [--cartao <tag>]');
    process.exit(1);
  }
  const i = resto.indexOf('--cartao');
  const cartao = i >= 0 ? resto[i + 1] : null;
  const sim = new CarregadorSimulado(url);
  let energiaWh = 120_000;
  let tx: number | null = null;
  let timer: NodeJS.Timeout | null = null;

  const medir = async () => {
    if (tx === null) return;
    energiaWh += 10; // 7,2 kW durante 5 s
    await sim.medir(tx, { energiaWh, potenciaW: 7200, correnteA: 31.3, tensaoV: 221, temperaturaC: 40 });
  };
  const iniciar = async (idTag: string) => {
    await sim.status('Preparing');
    const r = await sim.iniciar(idTag, energiaWh);
    console.log(`StartTransaction #${r.transactionId} (${r.status})`);
    if (r.status !== 'Accepted') return;
    tx = r.transactionId;
    await sim.status('Charging');
    timer = setInterval(() => void medir().catch((e) => console.error('medir:', e)), 5000);
  };
  const parar = async (motivo: string) => {
    if (tx === null) return;
    if (timer) clearInterval(timer);
    const id = tx;
    tx = null;
    await sim.parar(id, energiaWh, motivo);
    await sim.status('Finishing');
    await sim.status('Available');
    console.log(`StopTransaction #${id} (${motivo})`);
  };

  sim.responder('RemoteStartTransaction', (p) => {
    console.log('central pediu início:', p);
    setTimeout(() => void iniciar(p.idTag).catch((e) => console.error('iniciar:', e)), 1000);
    return { status: tx === null ? 'Accepted' : 'Rejected' };
  });
  sim.responder('RemoteStopTransaction', (p) => {
    console.log('central pediu parada:', p);
    setTimeout(() => void parar('Remote').catch((e) => console.error('parar:', e)), 500);
    return { status: p.transactionId === tx ? 'Accepted' : 'Rejected' };
  });

  await sim.conectar();
  console.log('boot:', await sim.boot());
  await sim.status('Available');
  console.log('conectado e livre. Inicie a recarga pela tela do NexON.');
  if (cartao) await iniciar(cartao);
  setInterval(() => void sim.chamar('Heartbeat').catch(() => process.exit(0)), 60_000);
  process.on('SIGINT', () => void parar('Local').finally(() => sim.fechar()).finally(() => process.exit(0)));
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
