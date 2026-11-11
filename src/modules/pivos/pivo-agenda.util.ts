import { FUSO_OPERACAO, type JanelaComAtivo } from '../../shared/util/janela-horario';
import { dentroDaPonta } from './pivo-automacao.util';

/**
 * Agenda do pivô POR DATA (NEXON-98) — o que a planilha traz: uma linha por irrigação, com dia,
 * início, fim (ou duração), sentido, percentímetro, água e canhão. Cada linha vira uma programação com
 * `data` preenchida, que o PivoAutomacaoService dispara só naquele dia. Dá para subir o ano todo.
 *
 * Aqui fica a validação, pura, para a API recusar a planilha inteira com o motivo de cada linha
 * (nada é gravado pela metade) e para os testes.
 */

export const MAX_ITENS_AGENDA = 2000;
/**
 * Minutos entre o fim de uma irrigação e o início da próxima. O pivô leva um tempo para
 * desligar (parada, bomba) e a seguinte só liga com ele parado: emendadas, a segunda não ligaria.
 */
export const INTERVALO_MIN_AGENDA = 10;

/** Linha já conferida, pronta para gravar. */
export interface ItemAgenda {
  linha: number;
  /** YYYY-MM-DD */
  data: string;
  /** HH:MM */
  hora_inicio: string;
  duracao_min: number;
  sentido: 'horario' | 'anti_horario';
  /** percentímetro 1–100; null no seco */
  velocidade: number | null;
  com_agua: boolean;
  /** liga o canhão final junto; nunca no seco */
  canhao: boolean;
  nome: string;
}
export interface ErroAgenda { linha: number; motivo: string }
/** Intervalo já agendado no pivô (para não sobrepor). */
export interface Ocupado { data: string; hora_inicio: string; duracao_min: number | null }

const pad = (n: number) => String(n).padStart(2, '0');

/** Hoje e a hora de agora no fuso da operação: { data: 'YYYY-MM-DD', minutos }. */
export function agoraEmSaoPaulo(d: Date = new Date()): { data: string; minutos: number } {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: FUSO_OPERACAO, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return { data: `${g('year')}-${g('month')}-${g('day')}`, minutos: (Number(g('hour')) % 24) * 60 + Number(g('minute')) };
}

/** 'YYYY-MM-DD', 'DD/MM/YYYY' ou Date → 'YYYY-MM-DD' (data de calendário válida) ou null. */
export function lerData(v: unknown): string | null {
  let a: number, m: number, d: number;
  if (v instanceof Date && !Number.isNaN(v.getTime())) { a = v.getUTCFullYear(); m = v.getUTCMonth() + 1; d = v.getUTCDate(); }
  else {
    const s = String(v ?? '').trim();
    const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
    const br = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
    if (iso) { a = +iso[1]; m = +iso[2]; d = +iso[3]; }
    else if (br) { a = +br[3]; m = +br[2]; d = +br[1]; }
    else return null;
  }
  const t = new Date(Date.UTC(a, m - 1, d));
  if (t.getUTCFullYear() !== a || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return `${a}-${pad(m)}-${pad(d)}`;
}

/** 'HH:MM' / 'H:MM' / 'HH:MM:SS' → minutos do dia, ou null. */
export function lerHora(v: unknown): number | null {
  const r = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(v ?? '').trim());
  if (!r) return null;
  const h = +r[1], mi = +r[2];
  return h > 23 || mi > 59 ? null : h * 60 + mi;
}
const hhmm = (min: number) => `${pad(Math.floor(min / 60) % 24)}:${pad(min % 60)}`;
const semAcento = (v: unknown) => String(v ?? '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[\s_-]+/g, '');

function lerSentido(v: unknown): 'horario' | 'anti_horario' | null {
  const s = semAcento(v);
  if (['horario', 'direita', 'avanco', 'd'].includes(s)) return 'horario';
  if (['antihorario', 'esquerda', 'reverso', 'e'].includes(s)) return 'anti_horario';
  return null;
}
function lerAgua(v: unknown): boolean | null {
  if (v === undefined || v === null || String(v).trim() === '') return true;   // em branco = com água
  if (typeof v === 'boolean') return v;
  const s = semAcento(v);
  if (['sim', 's', 'molhado', 'comagua', 'true', '1'].includes(s)) return true;
  if (['nao', 'n', 'seco', 'semagua', 'false', '0'].includes(s)) return false;
  return null;
}
/** Canhão final: em branco = Não. */
function lerCanhao(v: unknown): boolean | null {
  if (v === undefined || v === null || String(v).trim() === '') return false;
  if (typeof v === 'boolean') return v;
  const s = semAcento(v);
  if (['sim', 's', 'ligado', 'liga', 'true', '1'].includes(s)) return true;
  if (['nao', 'n', 'desligado', 'desliga', 'false', '0'].includes(s)) return false;
  return null;
}
const lerNumero = (v: unknown) => (v === undefined || v === null || String(v).trim() === '' ? null : Number(String(v).replace('%', '').replace(',', '.').trim()));

/** Minutos desde a época, tratando a data como UTC — só para comparar intervalos entre si. */
const instante = (data: string, minutos: number) => Date.parse(`${data}T00:00:00Z`) / 60000 + minutos;
const brData = (data: string) => `${data.slice(8, 10)}/${data.slice(5, 7)}/${data.slice(0, 4)}`;

/**
 * Confere as linhas da planilha. Devolve as boas e os erros; se houver QUALQUER erro, nada deve
 * ser gravado. `agora` = hoje e a hora no fuso da operação; `ponta` = bloqueio do horário de
 * ponta do pivô (início dentro dele não liga); `ocupados` = o que já está agendado e fica.
 */
export function validarAgenda(
  itens: unknown,
  agora: { data: string; minutos: number },
  ponta: { ativo?: boolean; inicio?: string; fim?: string; dias?: number[] | null } | null = null,
  ocupados: Ocupado[] = [],
): { ok: ItemAgenda[]; erros: ErroAgenda[] } {
  const erros: ErroAgenda[] = [];
  if (!Array.isArray(itens) || !itens.length) return { ok: [], erros: [{ linha: 0, motivo: 'A planilha não tem nenhuma linha de irrigação.' }] };
  if (itens.length > MAX_ITENS_AGENDA) return { ok: [], erros: [{ linha: 0, motivo: `Limite de ${MAX_ITENS_AGENDA} linhas por envio (vieram ${itens.length}).` }] };

  const limite = `${Number(agora.data.slice(0, 4)) + 2}${agora.data.slice(4)}`;   // até dois anos à frente
  const ok: ItemAgenda[] = [];

  itens.forEach((bruto, i) => {
    const it = (bruto ?? {}) as Record<string, unknown>;
    const linha = Number.isInteger(it.linha) && Number(it.linha) > 0 ? Number(it.linha) : i + 2;   // linha 1 é o cabeçalho
    const erro = (motivo: string) => { erros.push({ linha, motivo }); };

    const data = lerData(it.data);
    if (!data) return erro('Data inválida (use DD/MM/AAAA).');
    const ini = lerHora(it.hora_inicio);
    if (ini === null) return erro('Hora de início inválida (use HH:MM).');
    if (data < agora.data || (data === agora.data && ini <= agora.minutos)) return erro('Data e hora já passaram.');
    if (data > limite) return erro('Data muito distante (no máximo dois anos à frente).');

    let dur = lerNumero(it.duracao_min);
    if (dur === null) {
      const fim = lerHora(it.hora_fim);
      if (fim === null) return erro('Informe a hora de fim (HH:MM) ou a duração em minutos.');
      if (fim === ini) return erro('O fim é igual ao início. Para 24 horas, informe a duração (1440 minutos).');
      dur = (fim - ini + 1440) % 1440;   // fim menor que o início = vira o dia
    }
    if (!Number.isInteger(dur) || dur < 1 || dur > 10080) return erro('Duração inválida (de 1 minuto a 7 dias).');

    const sentido = lerSentido(it.sentido ?? it.direcao);
    if (!sentido) return erro('Sentido inválido (use Direita ou Esquerda).');
    const agua = lerAgua(it.com_agua ?? it.agua);
    if (agua === null) return erro('Água inválida (use Sim ou Não).');
    let vel: number | null = null;
    if (agua) {
      vel = lerNumero(it.percentual ?? it.velocidade ?? it.percentimetro);
      if (vel === null || !Number.isFinite(vel) || vel < 1 || vel > 100) return erro('Percentímetro inválido (de 1 a 100).');
      vel = Math.round(vel * 10) / 10;
    }
    const canhao = lerCanhao(it.canhao);
    if (canhao === null) return erro('Canhão inválido (use Sim ou Não).');
    if (canhao && !agua) return erro('Canhão não liga no seco: deixe o Canhão em branco ou ponha Água = Sim.');
    // Mesma regra do disparo (dentroDaPonta): início dentro do bloqueio de ponta não liga.
    const dSem = ((new Date(`${data}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;   // 1 = segunda … 7 = domingo
    if (ponta && dentroDaPonta(ponta as JanelaComAtivo, { minutos: ini, diaSemana: dSem })) {
      return erro(`Começa no horário de ponta (${ponta.inicio}–${ponta.fim}), que está bloqueado neste pivô.`);
    }
    ok.push({
      linha, data, hora_inicio: hhmm(ini), duracao_min: dur, sentido, velocidade: vel, com_agua: agua, canhao,
      nome: `${brData(data)} · ${hhmm(ini)} → ${hhmm(ini + dur)}`,
    });
  });

  // Sobreposição: o pivô faz uma irrigação por vez; a segunda seria pulada na hora, em silêncio.
  type Faixa = { ini: number; fim: number; linha: number | null; txt: string };
  const faixas: Faixa[] = [
    ...ocupados.flatMap((o): Faixa[] => {
      const ini = lerHora(o.hora_inicio);
      return ini === null ? [] : [{ ini: instante(o.data, ini), fim: instante(o.data, ini + Math.max(1, Number(o.duracao_min) || 1)), linha: null, txt: `${brData(o.data)} ${o.hora_inicio}` }];
    }),
    ...ok.map((x): Faixa => {
      const ini = lerHora(x.hora_inicio)!;
      return { ini: instante(x.data, ini), fim: instante(x.data, ini + x.duracao_min), linha: x.linha, txt: `linha ${x.linha}` };
    }),
  ].sort((a, b) => a.ini - b.ini || (a.linha ?? 0) - (b.linha ?? 0));
  let anterior: Faixa | null = null;
  const sobrepostas = new Set<number>();
  for (const f of faixas) {
    if (anterior && f.ini < anterior.fim + INTERVALO_MIN_AGENDA) {
      const culpada = f.linha ?? anterior.linha;   // marca a linha da planilha (a que já existia fica)
      if (culpada !== null && !sobrepostas.has(culpada)) {
        sobrepostas.add(culpada);
        const outra = f.linha !== null ? (anterior.linha !== null ? anterior.txt : `o que já está agendado em ${anterior.txt}`) : `o que já está agendado em ${f.txt}`;
        erros.push({
          linha: culpada,
          motivo: f.ini < anterior.fim ? `Sobrepõe ${outra}.`
            : `Fica a menos de ${INTERVALO_MIN_AGENDA} minutos de ${outra}: o pivô precisa desligar antes de ligar de novo.`,
        });
      }
      if (f.fim > anterior.fim) anterior = f;
    } else anterior = f;
  }

  erros.sort((a, b) => a.linha - b.linha);
  return { ok: erros.length ? [] : ok, erros };
}
