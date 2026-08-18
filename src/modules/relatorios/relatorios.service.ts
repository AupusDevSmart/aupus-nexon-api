import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';

const execFileAsync = promisify(execFile);

/**
 * Boletim semanal (PDF). O gerador vive ISOLADO em `relatorios-boletim/` (fora do
 * src, com node_modules/puppeteer próprio) e é chamado por child-process — assim o
 * Chromium não roda dentro do processo da API. `process.cwd()` = raiz do nexon-api.
 */
@Injectable()
export class RelatoriosService {
  private readonly logger = new Logger(RelatoriosService.name);
  private readonly geradorDir = path.join(process.cwd(), 'relatorios-boletim');

  /**
   * Núcleo ÚNICO de geração (padronizado): escreve o payload em JSON, chama o gerador
   * isolado por child-process e lê o resultado. `script` escolhe o relatório —
   * `gerar.js` (geração FV, HTML template) ou `gerar-consumo.mjs` (consumo, React SSR).
   * Ambos produzem PDF pelo MESMO Puppeteer isolado, com as mesmas opções.
   */
  private async gerar(payload: any, formato: 'html' | 'pdf', script = 'gerar.js'): Promise<Buffer | string> {
    const id = randomUUID();
    const inFile = path.join(os.tmpdir(), `boletim-${id}.json`);
    const outFile = path.join(os.tmpdir(), `boletim-${id}.${formato}`);
    await fs.writeFile(inFile, JSON.stringify(payload), 'utf8');
    try {
      await execFileAsync('node', [path.join(this.geradorDir, script), inFile, outFile], {
        cwd: this.geradorDir,
        timeout: 90_000,
        maxBuffer: 8 * 1024 * 1024,
      });
      return formato === 'pdf'
        ? await fs.readFile(outFile)
        : await fs.readFile(outFile, 'utf8');
    } catch (e) {
      this.logger.error(`Falha ao gerar ${script} (${formato}): ${e instanceof Error ? e.message : e}`);
      throw e;
    } finally {
      fs.unlink(inFile).catch(() => {});
      fs.unlink(outFile).catch(() => {});
    }
  }

  gerarPdf(payload: any): Promise<Buffer> {
    return this.gerar(payload, 'pdf') as Promise<Buffer>;
  }

  gerarHtml(payload: any): Promise<string> {
    return this.gerar(payload, 'html') as Promise<string>;
  }

  gerarPdfConsumo(payload: any): Promise<Buffer> {
    return this.gerar(payload, 'pdf', 'gerar-consumo.mjs') as Promise<Buffer>;
  }

  gerarHtmlConsumo(payload: any): Promise<string> {
    return this.gerar(payload, 'html', 'gerar-consumo.mjs') as Promise<string>;
  }

  /** Fase 0: dados de exemplo. Fase 1 troca por payload real (unidade + semana). */
  async dadosExemplo(): Promise<any> {
    const raw = await fs.readFile(path.join(this.geradorDir, 'dados_exemplo.json'), 'utf8');
    return JSON.parse(raw);
  }
}
