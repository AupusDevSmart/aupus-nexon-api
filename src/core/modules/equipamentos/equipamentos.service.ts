import { Injectable, NotFoundException, BadRequestException, ForbiddenException, Optional, Inject } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { IMqttBroker, MQTT_BROKER } from '../../common/interfaces/mqtt-broker.interface';
import { CreateEquipamentoDto } from './dto/create-equipamento.dto';
import { UpdateEquipamentoDto } from './dto/update-equipamento.dto';
import { EquipamentoQueryDto } from './dto/equipamento-query.dto';
import { CreateComponenteUARDto } from './dto/componente-uar.dto';
import { ConfigurarMqttDto } from './dto/configurar-mqtt.dto';
import { CreateEquipamentoRapidoDto } from './dto/create-equipamento-rapido.dto';
import {
  CreateEquipamentosLoteDto,
  LIMITE_ITENS_DO_LOTE,
} from './dto/create-equipamentos-lote.dto';
import { ProximoSequencialDto } from './dto/proximo-sequencial.dto';
import { EQUIPAMENTO_MQTT_CHANGED, EquipamentoMqttChangedPayload } from './events/equipamento-mqtt.events';
import { PermissionScopeService, ScopedUser } from '../auth/permission-scope.service';

@Injectable()
export class EquipamentosService {
  constructor(
    private prisma: PrismaService,
    private scopeService: PermissionScopeService,
    @Optional() @Inject(MQTT_BROKER) private mqttService?: IMqttBroker,
    @Optional() private eventEmitter?: EventEmitter2,
  ) {}

  /**
   * Emite o evento de mudanca de MQTT apos commit da transacao. Uso interno.
   * Sem-op se EventEmitter2 nao foi provido (consumidor sem @nestjs/event-emitter).
   */
  private emitMqttChanged(payload: EquipamentoMqttChangedPayload): void {
    if (!this.eventEmitter) return;
    this.eventEmitter.emit(EQUIPAMENTO_MQTT_CHANGED, payload);
  }

  /**
   * Valida formato basico de topico MQTT. Defensivo: rejeita vazio, whitespace,
   * leading/trailing slash e wildcards (+, #).
   */
  private isValidTopicoMqtt(topico: unknown): topico is string {
    if (!topico || typeof topico !== 'string') return false;
    const t = topico.trim();
    if (!t) return false;
    if (t.startsWith('/') || t.endsWith('/')) return false;
    if (t.includes('+') || t.includes('#')) return false;
    return true;
  }

  /**
   * Palavras que não ajudam a identificar o equipamento e por isso não entram
   * na sigla. "Transformador de Potência" precisa virar TRAPOT, não TRADE.
   */
  private static readonly PALAVRAS_IGNORADAS = new Set([
    'DE', 'DA', 'DO', 'DAS', 'DOS', 'E', 'A', 'O', 'AS', 'OS', 'EM', 'COM', 'PARA',
  ]);

  /**
   * A sigla da TAG, tirada do nome do equipamento.
   *
   * Três letras de cada uma das duas primeiras palavras que importam
   * ("Inversor Solar" -> INVSOL); quando só há uma palavra, as quatro primeiras
   * ("Disjuntor" -> DISJ, "M160" -> M160).
   *
   * O número no fim do nome é descartado: "Pivô 9" e "Pivô 10" são o mesmo tipo
   * de coisa e devem compartilhar a sigla PIVO — quem numera é o sequencial.
   *
   * A normalização remove acento e também os caracteres de desenho de caixa
   * (U+2500..U+257F), que é como parte dos nomes está gravada no banco por uma
   * corrupção antiga de codificação. Sem isso "Piv<lixo> Central" viraria sigla
   * com lixo dentro.
   */
  private siglaDoNome(nome: string): string {
    const limpo = (nome ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')   // acentos separados pelo NFD
      .replace(/[\u2500-\u257f]/g, ' ')  // mojibake cp850 (desenho de caixa)
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, ' ')
      .trim();

    let palavras = limpo.split(/\s+/).filter(Boolean);

    // Descarta o número final ("Pivo 9" -> ["PIVO"]), mas nunca o único token:
    // um equipamento chamado só "9" ainda precisa de sigla.
    if (palavras.length > 1 && /^\d+$/.test(palavras[palavras.length - 1])) {
      palavras = palavras.slice(0, -1);
    }

    const significativas = palavras.filter(
      (p) => !EquipamentosService.PALAVRAS_IGNORADAS.has(p),
    );
    const base = significativas.length > 0 ? significativas : palavras;

    if (base.length === 0) return 'EQP';
    if (base.length === 1) return base[0].slice(0, 4);
    return base[0].slice(0, 3) + base[1].slice(0, 3);
  }

  /**
   * TAG automática para quem não informou uma.
   *
   * Formato `SIGLA-NNN`, com o sequencial contado dentro da instalação: duas
   * usinas podem ter cada uma o seu INVSOL-001, que é como as etiquetas são
   * lidas em campo — ninguém procura um inversor sem saber em qual instalação
   * está.
   *
   * `usadas` carrega as TAGs decididas nesta mesma operação e ainda não
   * gravadas. Sem isso, um lote de vinte inversores consultaria o banco vinte
   * vezes e receberia INVSOL-001 nas vinte, porque nenhuma foi persistida
   * ainda.
   */
  /**
   * A instalação de um UAR é a do pai — o componente não tem unidade própria.
   * Sem isso o sequencial de um componente correria num escopo global, fora do
   * escopo dos equipamentos ao lado dele.
   */
  private async unidadeDoPai(paiId?: string | null): Promise<string | null> {
    const id = paiId?.trim();
    if (!id) return null;

    const pai = await this.prisma.equipamentos.findFirst({
      where: { id, deleted_at: null },
      select: { unidade_id: true },
    });

    return pai?.unidade_id?.trim() ?? null;
  }

  private async gerarTag(
    nome: string,
    unidadeId: string | null | undefined,
    usadas: Set<string> = new Set(),
  ): Promise<string> {
    const sigla = this.siglaDoNome(nome);
    const unidade = unidadeId?.trim();

    const existentes = await this.prisma.equipamentos.findMany({
      where: {
        deleted_at: null,
        ...(unidade ? { unidade_id: unidade } : {}),
        tag: { startsWith: `${sigla}-`, mode: 'insensitive' },
      },
      select: { tag: true },
    });

    let maior = 0;
    const considerar = (valor?: string | null) => {
      const texto = valor?.trim();
      if (!texto) return;
      const casa = new RegExp(`^${sigla}-(\\d+)$`, 'i').exec(texto);
      if (!casa) return;
      const numero = parseInt(casa[1], 10);
      if (numero > maior) maior = numero;
    };

    existentes.forEach((e) => considerar(e.tag));
    usadas.forEach(considerar);

    const tag = `${sigla}-${String(maior + 1).padStart(3, '0')}`;
    usadas.add(tag);
    return tag;
  }

  async create(createDto: CreateEquipamentoDto) {
    // Validar se unidade existe (para UC) ou equipamento pai existe (para UAR)
    if (createDto.classificacao === 'UC' && !createDto.unidade_id) {
      throw new BadRequestException('Equipamento UC deve ter uma unidade');
    }

    if (createDto.classificacao === 'UAR' && !createDto.equipamento_pai_id) {
      throw new BadRequestException('Componente UAR deve ter um equipamento pai');
    }

    if (createDto.unidade_id) {
      const unidadeExists = await this.prisma.unidades.findFirst({
        where: { id: createDto.unidade_id, deleted_at: null }
      });
      if (!unidadeExists) {
        throw new NotFoundException('Unidade não encontrada');
      }
    }

    if (createDto.equipamento_pai_id) {
      const equipamentoPaiExists = await this.prisma.equipamentos.findFirst({
        where: { id: createDto.equipamento_pai_id, deleted_at: null, classificacao: 'UC' }
      });
      if (!equipamentoPaiExists) {
        throw new NotFoundException('Equipamento pai não encontrado ou não é UC');
      }
    }

    // Validar topico_mqtt se fornecido
    if (createDto.topico_mqtt && !this.isValidTopicoMqtt(createDto.topico_mqtt)) {
      throw new BadRequestException(
        'topico_mqtt invalido (rejeitado: vazio, leading/trailing slash, wildcards + ou #)',
      );
    }

    // Extrair dados técnicos separadamente
    const { dados_tecnicos, pontos, ...equipamentoData } = createDto;

    // TAG automática só quando ninguém informou uma. Quem digita a etiqueta
    // tem motivo — costuma ser a que já está colada no ativo.
    if (!equipamentoData.tag?.trim()) {
      equipamentoData.tag = await this.gerarTag(
        equipamentoData.nome,
        equipamentoData.unidade_id ??
          (await this.unidadeDoPai(equipamentoData.equipamento_pai_id)),
      );
    }

    // ✅ Aumentar timeout da transação para 15 segundos
    const equipamento = await this.prisma.$transaction(async (prisma) => {
      // Criar equipamento
      const equipamento = await prisma.equipamentos.create({
        data: equipamentoData as any,
        include: {
          unidade: {
            select: {
              id: true,
              nome: true,
              planta: {
                select: {
                  id: true,
                  nome: true,
                  proprietario: {
                    select: {
                      id: true,
                      nome: true,
                      cpf_cnpj: true,
                    },
                  },
                },
              },
            },
          },
          equipamento_pai: {
            select: {
              id: true,
              nome: true,
              classificacao: true,
              criticidade: true,
            },
          },
        },
      });

      // Criar dados técnicos se fornecidos
      if (dados_tecnicos && dados_tecnicos.length > 0) {
        await prisma.equipamentos_dados_tecnicos.createMany({
          data: dados_tecnicos.map((dt) => ({
            equipamento_id: equipamento.id,
            ...dt,
          })),
        });
      }

      // Pontos de automacao (PR3) — todos novos no create (ignora id se vier).
      // No update, syncPontos faz upsert seletivo preservando IDs (ver update()).
      if (pontos && pontos.length > 0) {
        await prisma.equipamento_pontos.createMany({
          data: pontos.map((p, idx) => ({
            equipamento_id: equipamento.id,
            tipo: p.tipo,
            nome: p.nome.trim(),
            unidade: p.unidade?.trim() ?? null,
            ordem: p.ordem ?? idx,
            ativo: p.ativo ?? true,
          })),
        });
      }

      return equipamento;
    }, {
      maxWait: 15000, // Aguarda até 15s para começar a transação
      timeout: 15000,  // Timeout de 15s para completar a transação
    });

    // Emitir evento APOS commit — se o equipamento ja vem com MQTT habilitado e topico
    if (equipamento && (equipamento as any).mqtt_habilitado && (equipamento as any).topico_mqtt) {
      this.emitMqttChanged({
        equipamentoId: equipamento.id?.trim?.() ?? equipamento.id,
        topicoAntigo: null,
        topicoNovo: ((equipamento as any).topico_mqtt as string).trim(),
        habilitado: true,
      });
    }

    return equipamento;
  }

  /**
   * De onde continuar a numeração.
   *
   * Quem já tem três inversores e duplica o primeiro espera o quarto — não uma
   * cópia do número que copiou. O ponto de partida sai do que existe hoje, e
   * não do equipamento de origem.
   *
   * Nome e TAG contam os dois por unidade: ambos se repetem legitimamente entre
   * instalações, e é assim que a etiqueta é lida em campo. O lote usa o mesmo
   * escopo, tanto na TAG que gera sozinho quanto na que recusa por já existir.
   */
  async proximoSequencial(dto: ProximoSequencialDto) {
    const unidadeId = dto.unidade_id?.trim();
    const baseNome = dto.base_nome?.trim();
    const baseTag = dto.base_tag?.trim();

    const [nomes, tags] = await Promise.all([
      baseNome
        ? this.prisma.equipamentos.findMany({
            where: {
              deleted_at: null,
              ...(unidadeId ? { unidade_id: unidadeId } : {}),
              nome: { startsWith: baseNome, mode: 'insensitive' },
            },
            select: { nome: true },
          })
        : Promise.resolve([]),
      baseTag
        ? this.prisma.equipamentos.findMany({
            where: {
              deleted_at: null,
              ...(unidadeId ? { unidade_id: unidadeId } : {}),
              tag: { startsWith: baseTag, mode: 'insensitive' },
            },
            select: { tag: true },
          })
        : Promise.resolve([]),
    ]);

    return {
      proximo_nome: this.proximoNumero(nomes.map((n) => n.nome), baseNome),
      proximo_tag: this.proximoNumero(tags.map((t) => t.tag), baseTag),
    };
  }

  /**
   * O maior número que segue o prefixo, mais um.
   *
   * Só conta o que é exatamente prefixo + número: "Inversor 12" conta, mas
   * "Inversor 12 reserva" não — do contrário um nome descritivo qualquer
   * empurraria a numeração para longe sem motivo.
   */
  private proximoNumero(valores: (string | null)[], prefixo?: string): number {
    if (!prefixo) return 1;

    let maior = 0;

    for (const valor of valores) {
      const texto = valor?.trim();
      if (!texto) continue;
      if (!texto.toLowerCase().startsWith(prefixo.toLowerCase())) continue;

      const resto = texto.slice(prefixo.length).trim();
      if (!/^\d+$/.test(resto)) continue;

      const numero = parseInt(resto, 10);
      if (numero > maior) maior = numero;
    }

    return maior + 1;
  }

  /**
   * Cadastra vários equipamentos iguais de uma vez.
   *
   * Uma unidade costuma ter dezenas do mesmo modelo — vinte inversores numa
   * usina — e o que muda entre eles é pouco: nome, TAG, número de série e onde
   * exatamente está. O resto é o mesmo bloco repetido.
   *
   * Tudo numa transação só. Vinte cadastros disparados um a um pelo navegador
   * deixam órfãos quando o décimo terceiro falha, e sobra para alguém caçar e
   * apagar na mão. Aqui, ou entram os N, ou não entra nenhum.
   *
   * O plano de manutenção não entra no lote de propósito: cada equipamento
   * recebe o seu depois, porque vincular um plano cria uma cópia própria dele
   * com tarefas e datas — não é o tipo de coisa que se replica no atacado.
   */
  async criarEmLote(dto: CreateEquipamentosLoteDto) {
    const { itens, dados_tecnicos, pontos, ...comum } = dto;

    if (comum.classificacao === 'UC' && !comum.unidade_id) {
      throw new BadRequestException('Equipamento UC deve ter uma unidade');
    }

    if (comum.classificacao === 'UAR' && !comum.equipamento_pai_id) {
      throw new BadRequestException('Componente UAR deve ter um equipamento pai');
    }

    if (comum.unidade_id) {
      const unidade = await this.prisma.unidades.findFirst({
        where: { id: comum.unidade_id, deleted_at: null },
        select: { id: true },
      });
      if (!unidade) throw new NotFoundException('Unidade não encontrada');
    }

    if (comum.equipamento_pai_id) {
      const pai = await this.prisma.equipamentos.findFirst({
        where: { id: comum.equipamento_pai_id, deleted_at: null, classificacao: 'UC' },
        select: { id: true },
      });
      if (!pai) throw new NotFoundException('Equipamento pai não encontrado ou não é UC');
    }

    // Um tópico serve a um equipamento só. Vindo do bloco comum, ele cairia
    // igual nos N e os dados de todos se misturariam na mesma série. Recusar é
    // mais honesto do que ignorar em silêncio.
    if (itens.length > 1 && comum.topico_mqtt) {
      throw new BadRequestException(
        'Tópico MQTT não pode ser definido em lote: cada equipamento precisa do seu. ' +
          'Cadastre sem o tópico e configure um por um depois.',
      );
    }

    if (comum.topico_mqtt && !this.isValidTopicoMqtt(comum.topico_mqtt)) {
      throw new BadRequestException(
        'topico_mqtt invalido (rejeitado: vazio, leading/trailing slash, wildcards + ou #)',
      );
    }

    const unidadeDoLote =
      comum.unidade_id?.trim() ?? (await this.unidadeDoPai(comum.equipamento_pai_id));

    await this.validarItensDoLote(itens, unidadeDoLote);

    // O `usadas` atravessa o laço inteiro: as TAGs deste lote ainda não estão
    // no banco, e sem lembrar delas os vinte inversores sairiam todos como
    // INVSOL-001.
    //
    // Laço sequencial, e não `Promise.all`: em paralelo todas as chamadas
    // leriam o `usadas` antes de qualquer uma escrever nele, e o acumulador
    // não serviria para nada. São N consultas rápidas por índice, antes da
    // transação.
    const usadas = new Set<string>();
    const normalizados: Record<string, unknown>[] = [];

    for (const item of itens) {
      const nome = item.nome.trim();
      const tag = item.tag?.trim();

      normalizados.push({
        ...comum,
        nome,
        tag: tag || (await this.gerarTag(nome, unidadeDoLote, usadas)),
        numero_serie: item.numero_serie?.trim() || null,
        localizacao_especifica: item.localizacao_especifica?.trim() || null,
      });
    }

    // A janela cresce com o lote. As inserções em si são rápidas — o grosso das
    // falhas prováveis já foi barrado na validação acima —, mas 50 equipamentos
    // com dados técnicos não cabem nos 15s que bastam para um.
    const janela = Math.min(60_000, 15_000 + itens.length * 1_000);

    const criados = await this.prisma.$transaction(
      async (tx) => {
        const resultado: any[] = [];

        for (const data of normalizados) {
          const equipamento = await tx.equipamentos.create({ data: data as any });

          if (dados_tecnicos && dados_tecnicos.length > 0) {
            await tx.equipamentos_dados_tecnicos.createMany({
              data: dados_tecnicos.map((dt) => ({
                equipamento_id: equipamento.id,
                ...dt,
              })),
            });
          }

          if (pontos && pontos.length > 0) {
            await tx.equipamento_pontos.createMany({
              data: pontos.map((p, idx) => ({
                equipamento_id: equipamento.id,
                tipo: p.tipo,
                nome: p.nome.trim(),
                unidade: p.unidade?.trim() ?? null,
                ordem: p.ordem ?? idx,
                ativo: p.ativo ?? true,
              })),
            });
          }

          resultado.push(equipamento);
        }

        return resultado;
      },
      { maxWait: janela, timeout: janela },
    );

    // Só faz sentido no lote de um, que é o único que aceita tópico.
    const comMqtt = criados.find(
      (e: any) => e.mqtt_habilitado && e.topico_mqtt,
    );
    if (comMqtt) {
      this.emitMqttChanged({
        equipamentoId: comMqtt.id?.trim?.() ?? comMqtt.id,
        topicoAntigo: null,
        topicoNovo: (comMqtt.topico_mqtt as string).trim(),
        habilitado: true,
      });
    }

    return {
      total: criados.length,
      equipamentos: criados,
    };
  }

  /**
   * Recusa o lote inteiro antes de criar qualquer coisa.
   *
   * Barrar aqui é o que permite criar tudo numa transação com folga: o que
   * sobra depois são inserções simples, sem consulta nem regra pelo caminho.
   */
  private async validarItensDoLote(
    itens: CreateEquipamentosLoteDto['itens'],
    unidadeId?: string | null,
  ) {
    if (itens.length > LIMITE_ITENS_DO_LOTE) {
      throw new BadRequestException(
        `No máximo ${LIMITE_ITENS_DO_LOTE} equipamentos por lote`,
      );
    }

    const problemas: string[] = [];

    const nomes = new Set<string>();
    const tags = new Set<string>();
    const series = new Set<string>();

    itens.forEach((item, indice) => {
      const linha = indice + 1;
      const nome = item.nome?.trim();

      if (!nome) {
        problemas.push(`Linha ${linha}: nome em branco`);
      } else if (nomes.has(nome.toLowerCase())) {
        problemas.push(`Linha ${linha}: nome "${nome}" repetido no lote`);
      } else {
        nomes.add(nome.toLowerCase());
      }

      const tag = item.tag?.trim();
      if (tag) {
        if (tags.has(tag.toLowerCase())) {
          problemas.push(`Linha ${linha}: TAG "${tag}" repetida no lote`);
        } else {
          tags.add(tag.toLowerCase());
        }
      }

      const serie = item.numero_serie?.trim();
      if (serie) {
        if (series.has(serie.toLowerCase())) {
          problemas.push(`Linha ${linha}: número de série "${serie}" repetido no lote`);
        } else {
          series.add(serie.toLowerCase());
        }
      }
    });

    // A TAG não tem restrição de unicidade no banco, então colidir passaria
    // batido e só apareceria como confusão mais tarde, na hora de procurar o
    // equipamento pela etiqueta.
    //
    // A colisão é medida dentro da instalação, não no sistema todo: é assim que
    // a etiqueta é lida em campo — ninguém procura um inversor sem saber em
    // qual instalação está — e é o mesmo escopo da TAG gerada automaticamente.
    // Exigir unicidade global aqui recusaria a própria TAG que geramos para a
    // instalação vizinha.
    if (tags.size > 0) {
      const informadas = itens
        .map((i) => i.tag?.trim())
        .filter((t): t is string => !!t);

      const jaExistem = await this.prisma.equipamentos.findMany({
        where: {
          tag: { in: informadas },
          deleted_at: null,
          ...(unidadeId ? { unidade_id: unidadeId } : {}),
        },
        select: { tag: true, nome: true },
      });

      for (const existente of jaExistem) {
        problemas.push(
          `TAG "${existente.tag?.trim()}" já está em uso nesta instalação por "${existente.nome}"`,
        );
      }
    }

    if (problemas.length > 0) {
      throw new BadRequestException(problemas);
    }
  }

  /**
   * Cria um equipamento rapidamente com dados mínimos para uso imediato no diagrama
   * Ideal para adicionar equipamentos durante a edição do sinóptico
   * Dados completos podem ser preenchidos posteriormente na página de cadastro
   */
  async criarEquipamentoRapido(dto: CreateEquipamentoRapidoDto) {
    // Validar se unidade existe
    const unidade = await this.prisma.unidades.findFirst({
      where: { id: dto.unidade_id?.trim(), deleted_at: null }
    });

    if (!unidade) {
      throw new NotFoundException('Unidade não encontrada');
    }

    // Validar se tipo de equipamento existe e buscar categoria/fabricante
    const tipoEquipamento = await this.prisma.tipos_equipamentos.findUnique({
      where: { id: dto.tipo_equipamento_id?.trim() },
      include: {
        categoria: true,
      },
    });

    if (!tipoEquipamento) {
      throw new NotFoundException('Tipo de equipamento não encontrado');
    }

    // Gerar nome automático se não fornecido
    let nome = dto.nome?.trim();
    if (!nome) {
      // Contar quantos equipamentos desse tipo já existem na unidade
      const count = await this.prisma.equipamentos.count({
        where: {
          unidade_id: dto.unidade_id?.trim(),
          tipo_equipamento_id: dto.tipo_equipamento_id?.trim(),
          deleted_at: null
        }
      });

      nome = `${tipoEquipamento.nome} ${count + 1}`;
    }

    // Criar equipamento com dados mínimos
    const equipamento = await this.prisma.equipamentos.create({
      data: {
        nome: nome.trim(),
        // Aqui a TAG automática pesa mais do que no cadastro completo: quem
        // cria pelo diagrama não passa por formulário nenhum, e sem isso o
        // equipamento nasceria sem etiqueta.
        tag:
          dto.tag?.trim() ||
          (await this.gerarTag(nome.trim(), dto.unidade_id?.trim())),
        unidade_id: dto.unidade_id.trim(),
        classificacao: dto.classificacao || 'UC',
        tipo_equipamento_id: dto.tipo_equipamento_id.trim(),
        criticidade: '3', // Criticidade média por padrão
        em_operacao: 'sim',
        // ✅ Preencher fabricante do modelo automaticamente
        fabricante: tipoEquipamento.fabricante,
        modelo: null,
        numero_serie: null,
        localizacao: 'A definir',
      },
      include: {
        tipo_equipamento_rel: {
          select: {
            id: true,
            codigo: true,
            nome: true,
            categoria_id: true,
            categoria: true,
            fabricante: true,
            largura_padrao: true,
            altura_padrao: true,
            icone_svg: true,
          }
        },
        unidade: {
          select: {
            id: true,
            nome: true,
            planta: {
              select: {
                id: true,
                nome: true,
              }
            }
          }
        }
      }
    });

    return {
      success: true,
      message: 'Equipamento criado rapidamente. Complete os dados depois na página de cadastro.',
      data: {
        ...equipamento,
        // Garantir trim em todos os campos de string
        id: equipamento.id?.trim(),
        nome: equipamento.nome?.trim(),
        tag: equipamento.tag?.trim() || null,
        tipoEquipamento: equipamento.tipo_equipamento_rel,
      },
    };
  }

  async findAll(query: EquipamentoQueryDto, user?: ScopedUser) {
    const {
      page = 1,
      limit = 10,
      search,
      unidade_id,
      planta_id,
      proprietario_id,
      classificacao,
      criticidade,
      equipamento_pai_id,
      semDiagrama,
      semPlano,
      ocultarVirtuais,
      tipo,
      mqtt_habilitado,
      orderBy = 'created_at',
      orderDirection = 'desc'
    } = query;
    const skip = (page - 1) * limit;

    // Construir filtros
    const where: any = {
      deleted_at: null,
      AND: [] as any[],
    };

    // Scope RBAC por planta (operador/proprietario veem apenas equipamentos das plantas vinculadas).
    // Filtro aninhado via unidade.planta_id (equipamentos.planta_id pode estar null).
    const scope = await this.scopeService.getScope(user);
    if (this.scopeService.isScoped(scope)) {
      where.AND.push({ unidade: { planta_id: { in: scope } } });
    }

    if (search) {
      where.OR = [
        { nome: { contains: search, mode: 'insensitive' } },
        { tag: { contains: search, mode: 'insensitive' } },
        { fabricante: { contains: search, mode: 'insensitive' } },
        { modelo: { contains: search, mode: 'insensitive' } },
        { numero_serie: { contains: search, mode: 'insensitive' } },
        { localizacao: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (unidade_id) where.unidade_id = unidade_id;

    // Filtros hierárquicos: proprietário > planta > unidade
    // Prioridade: unidade > planta > proprietário
    // Se unidade está selecionada, não aplicar filtros de planta ou proprietário
    if (!unidade_id) {
      // Filtrar por planta (via relação com unidade)
      if (planta_id) {
        where.unidade = {
          planta_id: planta_id.trim()
        };
      }
      // Filtrar por proprietário (via relação com unidade -> planta -> proprietário)
      else if (proprietario_id) {
        where.unidade = {
          planta: {
            proprietario_id: proprietario_id.trim()
          }
        };
      }
    }

    if (classificacao) where.classificacao = classificacao;
    if (criticidade) where.criticidade = criticidade;
    if (equipamento_pai_id) where.equipamento_pai_id = equipamento_pai_id;

    // Filtro semDiagrama - equipamentos não posicionados em diagramas
    if (semDiagrama !== undefined) {
      if (semDiagrama === true) {
        where.diagrama_id = null;
      } else {
        where.diagrama_id = { not: null };
      }
    }

    // Filtro por tipo de equipamento
    if (tipo) {
      where.tipo_equipamento_id = tipo;
    }

    // PONTO e BARRAMENTO sao componentes visuais do diagrama, nao equipamentos
    // de cadastro. Esconde-los AQUI e nao depois da consulta e o que mantem a
    // pagina cheia: filtrar no cliente descartava itens da pagina ja recortada,
    // e a partir da segunda pagina a tela mostrava menos de 10 — com o total
    // ainda contando os escondidos.
    if (ocultarVirtuais) {
      where.AND.push({
        OR: [
          { tipo_equipamento_id: null },
          { tipo_equipamento_rel: { codigo: { notIn: ['PONTO', 'BARRAMENTO'] } } },
        ],
      });
    }

    // Filtro semPlano - equipamentos sem plano de manutenção
    if (semPlano !== undefined) {
      if (semPlano === true) {
        where.planos_manutencao = null;
      } else {
        where.planos_manutencao = { isNot: null };
      }
    }

    // Filtro por MQTT habilitado
    if (mqtt_habilitado !== undefined) {
      where.mqtt_habilitado = mqtt_habilitado;
    }

    const [data, total] = await Promise.all([
      this.prisma.equipamentos.findMany({
        where,
        skip,
        take: limit,
        // O id desempata. A ordem padrao e created_at, que em DEV ja tem tres
        // equipamentos no mesmo segundo — importacao em lote produz empates
        // muito maiores. Empate sem desempate + OFFSET/LIMIT faz a mesma linha
        // cair em duas paginas e outra sumir. Ver plantas.service.
        orderBy: [{ [orderBy]: orderDirection }, { id: 'asc' }],
        include: {
          unidade: {
            select: {
              id: true,
              nome: true,
              planta: {
                select: {
                  id: true,
                  nome: true,
                  proprietario: {
                    select: {
                      id: true,
                      nome: true,
                      cpf_cnpj: true,
                    },
                  },
                },
              },
            },
          },
          tipo_equipamento_rel: {
            select: {
              id: true,
              codigo: true,
              nome: true,
              categoria: true,
              largura_padrao: true,
              altura_padrao: true,
              icone_svg: true,
            },
          },
          equipamento_pai: {
            select: {
              id: true,
              nome: true,
              classificacao: true,
              criticidade: true,
            },
          },
          equipamentos_filhos: {
            select: {
              id: true,
              nome: true,
              classificacao: true,
            },
            where: {
              deleted_at: null,
            },
          },
        },
      }),
      this.prisma.equipamentos.count({ where }),
    ]);

    // Calcular total de equipamentos sem diagrama (para meta)
    const totalSemDiagrama = unidade_id
      ? await this.prisma.equipamentos.count({
          where: {
            ...where,
            diagrama_id: null,
          },
        })
      : undefined;

    // Adicionar contagem de componentes e informações de diagrama
    const dataWithCounts = data.map((equipamento: any) => ({
      ...equipamento,
      totalComponentes: equipamento.equipamentos_filhos?.length || 0,
      noDiagrama: equipamento.diagrama_id !== null,
      diagramaId: equipamento.diagrama_id,
      tipoEquipamento: equipamento.tipo_equipamento_rel,
    }));

    return {
      data: dataWithCounts,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
      meta: totalSemDiagrama !== undefined ? { totalSemDiagrama } : undefined,
    };
  }

  async findOne(id: string, user?: ScopedUser) {
    const equipamento = await this.prisma.equipamentos.findFirst({
      where: { id, deleted_at: null },
      include: {
        unidade: {
          include: {
            planta: true,
          },
        },
        tipo_equipamento_rel: {
          select: {
            id: true,
            codigo: true,
            nome: true,
            categoria: true,
            largura_padrao: true,
            altura_padrao: true,
            icone_svg: true,
          },
        },
        equipamento_pai: {
          select: {
            id: true,
            nome: true,
            classificacao: true,
            criticidade: true,
          },
        },
        equipamentos_filhos: {
          where: { deleted_at: null },
          include: {
            dados_tecnicos: true,
          },
        },
        dados_tecnicos: true,
        // Pontos de automacao (PR3) — apenas ativos (nao soft-deletados)
        equipamento_pontos: {
          where: { deleted_at: null },
          orderBy: [{ ordem: 'asc' }, { nome: 'asc' }],
        },
      },
    });

    if (!equipamento) {
      throw new NotFoundException('Equipamento não encontrado');
    }

    // Scope RBAC: 403 se a planta do equipamento (via unidade) nao esta no escopo do usuario
    const plantaIdEfetivo = equipamento.unidade?.planta_id ?? equipamento.planta_id ?? null;
    await this.scopeService.assertPlantaInScope(plantaIdEfetivo, user);

    return {
      ...equipamento,
      totalComponentes: equipamento.equipamentos_filhos?.length || 0,
      tipoEquipamento: equipamento.tipo_equipamento_rel,
    };
  }

  async update(id: string, updateDto: UpdateEquipamentoDto) {
    const equipamentoExists = await this.prisma.equipamentos.findFirst({
      where: { id, deleted_at: null },
      select: { id: true, topico_mqtt: true, mqtt_habilitado: true },
    });

    if (!equipamentoExists) {
      throw new NotFoundException('Equipamento não encontrado');
    }

    // Normalizar topico_mqtt: string vazia / whitespace eh "remover topico" -> null.
    // Evita rejeitar payload de equipamentos sem MQTT habilitado que enviam topico_mqtt="".
    if (
      typeof updateDto.topico_mqtt === 'string' &&
      updateDto.topico_mqtt.trim() === ''
    ) {
      updateDto.topico_mqtt = null;
    }

    // Validar topico_mqtt novo, se vier no payload e nao for null
    if (
      updateDto.topico_mqtt !== undefined &&
      updateDto.topico_mqtt !== null &&
      !this.isValidTopicoMqtt(updateDto.topico_mqtt)
    ) {
      throw new BadRequestException(
        'topico_mqtt invalido (rejeitado: leading/trailing slash, wildcards + ou #)',
      );
    }

    // Capturar mudanca em campos MQTT (somente se algum dos dois aparece no payload)
    const mqttFieldTouched =
      Object.prototype.hasOwnProperty.call(updateDto, 'topico_mqtt') ||
      Object.prototype.hasOwnProperty.call(updateDto, 'mqtt_habilitado');
    const topicoAntigo = equipamentoExists.topico_mqtt?.trim() || null;
    const habilitadoAntigo = !!equipamentoExists.mqtt_habilitado;

    // Extrair dados técnicos e pontos separadamente
    const { dados_tecnicos, pontos, ...equipamentoData } = updateDto;

    // ✅ CORRIGIDO: Aumentar timeout da transação para 15 segundos (suficiente para processar dados técnicos)
    const equipamento = await this.prisma.$transaction(async (prisma) => {
      // Atualizar equipamento
      const equipamento = await prisma.equipamentos.update({
        where: { id },
        data: equipamentoData,
        include: {
          unidade: {
            select: {
              id: true,
              nome: true,
              planta: {
                select: {
                  id: true,
                  nome: true,
                  proprietario: {
                    select: {
                      id: true,
                      nome: true,
                      cpf_cnpj: true,
                    },
                  },
                },
              },
            },
          },
          equipamento_pai: {
            select: {
              id: true,
              nome: true,
              classificacao: true,
              criticidade: true,
            },
          },
        },
      });

      // Atualizar dados técnicos se fornecidos
      if (dados_tecnicos) {
        // Remover dados técnicos existentes
        await prisma.equipamentos_dados_tecnicos.deleteMany({
          where: { equipamento_id: id },
        });

        // Criar novos dados técnicos
        if (dados_tecnicos.length > 0) {
          await prisma.equipamentos_dados_tecnicos.createMany({
            data: dados_tecnicos.map((dt) => ({
              equipamento_id: id,
              ...dt,
            })),
          });
        }
      }

      // Pontos de automacao (PR3) — sync seletivo preservando IDs.
      // - pontos com id existente: UPDATE
      // - pontos sem id mas com nome ja soft-deletado: reativa (UPDATE deleted_at=null)
      // - pontos sem id e sem soft-deletado: CREATE
      // - pontos no banco que NAO vieram no payload: cascade ton_bo (SET NULL) + soft-delete
      if (pontos) {
        const existentes = await prisma.equipamento_pontos.findMany({
          where: { equipamento_id: id, deleted_at: null },
          select: { id: true },
        });
        const existentesIds = new Set(existentes.map((p) => p.id.trim()));
        const recebidosIds = new Set(
          pontos.filter((p) => p.id).map((p) => p.id!.trim()),
        );

        // Cascade + soft-delete dos pontos que sumiram do payload.
        // ton_bo.equipamento_ponto_id vira NULL antes do soft-delete (FK SET NULL
        // do schema so atua em hard delete, nao no soft).
        const aRemover = existentes
          .map((p) => p.id)
          .filter((eid) => !recebidosIds.has(eid.trim()));
        if (aRemover.length > 0) {
          await prisma.ton_bo.updateMany({
            where: { equipamento_ponto_id: { in: aRemover } },
            data: { equipamento_ponto_id: null },
          });
          await prisma.equipamento_pontos.updateMany({
            where: { id: { in: aRemover } },
            data: { deleted_at: new Date() },
          });
        }

        // Pre-carrega soft-deletados desse equipamento por nome — pra reativar
        // quando user recria ponto com mesmo nome que ja existiu (evita conflict
        // no UNIQUE (equipamento_id, nome)).
        const softDeletados = await prisma.equipamento_pontos.findMany({
          where: { equipamento_id: id, deleted_at: { not: null } },
          select: { id: true, nome: true },
        });
        const softByNome = new Map<string, string>();
        for (const s of softDeletados) softByNome.set(s.nome, s.id);

        // Upsert linha por linha (precisa de update individual pra preservar id existente)
        for (let idx = 0; idx < pontos.length; idx++) {
          const p = pontos[idx];
          const trimmedId = p.id?.trim();
          const nome = p.nome.trim();
          const data = {
            tipo: p.tipo,
            nome,
            unidade: p.unidade?.trim() ?? null,
            ordem: p.ordem ?? idx,
            ativo: p.ativo ?? true,
          };

          if (trimmedId && existentesIds.has(trimmedId)) {
            // UPDATE de ponto existente
            await prisma.equipamento_pontos.update({
              where: { id: trimmedId },
              data,
            });
          } else if (softByNome.has(nome)) {
            // Reativa soft-deletado com mesmo nome
            await prisma.equipamento_pontos.update({
              where: { id: softByNome.get(nome)! },
              data: { ...data, deleted_at: null },
            });
          } else {
            // CREATE novo
            await prisma.equipamento_pontos.create({
              data: {
                equipamento_id: id,
                ...data,
              },
            });
          }
        }
      }

      return equipamento;
    }, {
      maxWait: 15000, // Aguarda até 15s para começar a transação
      timeout: 15000,  // Timeout de 15s para completar a transação
    });

    // Emitir evento APOS commit, somente se topico_mqtt ou mqtt_habilitado mudou
    if (mqttFieldTouched && equipamento) {
      const topicoNovo = (equipamento as any).topico_mqtt?.trim() || null;
      const habilitadoNovo = !!(equipamento as any).mqtt_habilitado;
      const houveMudanca =
        topicoNovo !== topicoAntigo || habilitadoNovo !== habilitadoAntigo;

      if (houveMudanca) {
        this.emitMqttChanged({
          equipamentoId: equipamento.id?.trim?.() ?? equipamento.id,
          topicoAntigo,
          topicoNovo,
          habilitado: habilitadoNovo,
        });
      }
    }

    return equipamento;
  }

  async remove(id: string) {
    const equipamento = await this.prisma.equipamentos.findFirst({
      where: { id, deleted_at: null },
      include: {
        equipamentos_filhos: {
          where: { deleted_at: null },
        },
      },
    });

    if (!equipamento) {
      throw new NotFoundException('Equipamento não encontrado');
    }

    // Se for UC e tiver componentes, impedir exclusão
    if (equipamento.classificacao === 'UC' && equipamento.equipamentos_filhos.length > 0) {
      throw new BadRequestException('Não é possível excluir equipamento que possui componentes UAR');
    }

    // Soft delete
    await this.prisma.equipamentos.update({
      where: { id },
      data: { deleted_at: new Date() },
    });

    // Se o equipamento tinha MQTT habilitado, avisa para desinscrever
    if (equipamento.mqtt_habilitado && equipamento.topico_mqtt?.trim()) {
      this.emitMqttChanged({
        equipamentoId: equipamento.id?.trim?.() ?? equipamento.id,
        topicoAntigo: equipamento.topico_mqtt.trim(),
        topicoNovo: null,
        habilitado: false,
      });
    }

    return { message: 'Equipamento removido com sucesso' };
  }

  async findComponentesByEquipamento(equipamentoId: string) {
    const equipamento = await this.prisma.equipamentos.findFirst({
      where: { id: equipamentoId, deleted_at: null, classificacao: 'UC' },
    });

    if (!equipamento) {
      throw new NotFoundException('Equipamento UC não encontrado');
    }

    return await this.prisma.equipamentos.findMany({
      where: {
        equipamento_pai_id: equipamentoId,
        deleted_at: null,
      },
      include: {
        dados_tecnicos: true,
      },
      orderBy: { created_at: 'desc' },
    });
  }

  async findEquipamentosUC() {
    return await this.prisma.equipamentos.findMany({
      where: {
        classificacao: 'UC',
        deleted_at: null,
      },
      select: {
        id: true,
        nome: true,
        fabricante: true,
        modelo: true,
        unidade: {
          select: {
            id: true,
            nome: true,
            planta: {
              select: {
                id: true,
                nome: true,
              },
            },
          },
        },
      },
      orderBy: { nome: 'asc' },
    });
  }

  async findUARDetalhes(uarId: string) {
    const uar = await this.prisma.equipamentos.findFirst({
      where: {
        id: uarId,
        deleted_at: null,
        classificacao: 'UAR'
      },
      include: {
        unidade: {
          select: {
            id: true,
            nome: true,
            planta: {
              select: {
                id: true,
                nome: true,
                localizacao: true,
              },
            },
          },
        },
        equipamento_pai: {
          select: {
            id: true,
            nome: true,
            classificacao: true,
            criticidade: true,
            fabricante: true,
            modelo: true,
            localizacao: true,
          },
        },
        dados_tecnicos: {
          orderBy: { campo: 'asc' },
        },
      },
    });

    if (!uar) {
      throw new NotFoundException('Componente UAR não encontrado');
    }

    return uar;
  }

  async findComponentesParaGerenciar(ucId: string) {
    // Verificar se UC existe
    const equipamentoUC = await this.prisma.equipamentos.findFirst({
      where: { id: ucId, deleted_at: null, classificacao: 'UC' },
      select: {
        id: true,
        nome: true,
        fabricante: true,
        modelo: true,
        unidade: {
          select: {
            id: true,
            nome: true,
            planta: {
              select: { id: true, nome: true }
            }
          }
        }
      }
    });

    if (!equipamentoUC) {
      throw new NotFoundException('Equipamento UC não encontrado');
    }

    // Buscar componentes UAR
    const componentes = await this.prisma.equipamentos.findMany({
      where: {
        equipamento_pai_id: ucId,
        deleted_at: null,
      },
      include: {
        dados_tecnicos: {
          orderBy: { campo: 'asc' },
        },
        // O tipo com CODIGO, categoria e fabricante.
        //
        // Sem esta relacao o front nao monta `tipoEquipamentoObj`, e o sheet do
        // UAR caia no id como se fosse codigo: dava 404 no /codigo/:codigo ao
        // abrir, e categoria e modelo ficavam em branco porque o tipo completo
        // nunca chegava. Um include a menos custava dois sintomas.
        //
        // Mesmo select do findOne, para os dois caminhos entregarem a mesma
        // forma — foi a divergencia entre eles que produziu o bug.
        tipo_equipamento_rel: {
          select: {
            id: true,
            codigo: true,
            nome: true,
            categoria_id: true,
            categoria: true,
            fabricante: true,
            largura_padrao: true,
            altura_padrao: true,
            icone_svg: true,
          }
        },
      },
      orderBy: { created_at: 'desc' },
    });

    return {
      equipamentoUC,
      componentes,
    };
  }

  /**
   * As colunas que o cliente pode gravar em `equipamentos`, lidas do schema.
   *
   * Aqui havia uma lista de 18 campos escrita a mao. Ela envelheceu: `modelo`
   * estava la, mas `tipo_equipamento_id` — a FK que de fato guarda o modelo
   * escolhido — nunca entrou. Quem editava o modelo de um UAR pelo sheet do UC
   * via a tela salvar sem erro nenhum e o campo voltar vazio no reload, porque
   * o valor era descartado em silencio no meio do caminho. `tag`,
   * `fabricante_custom`, `foto_url`, o bloco MCPSE e os dados tecnicos caiam
   * pelo mesmo buraco.
   *
   * Uma lista de permissao que precisa crescer a cada coluna nova erra por
   * omissao, e o erro e mudo. Invertendo para uma lista de negacao, coluna nova
   * passa a funcionar sozinha e so o que é de fato proibido precisa ser dito.
   *
   * O DMMF e o proprio schema em tempo de execucao: se a coluna existe, ela
   * esta aqui.
   */
  private static readonly NAO_GRAVAVEIS = new Set([
    'id', 'created_at', 'updated_at', 'deleted_at',
    // Definidos pelo pai, nao pelo item do lote.
    'classificacao', 'equipamento_pai_id', 'unidade_id',
  ]);

  private camposGravaveisDoEquipamento(entrada: Record<string, any>) {
    const modelo = Prisma.dmmf.datamodel.models.find(m => m.name === 'equipamentos');
    const colunas = new Set(
      (modelo?.fields ?? [])
        .filter(f => f.kind === 'scalar' && !EquipamentosService.NAO_GRAVAVEIS.has(f.name))
        .map(f => f.name),
    );

    // String vazia e um valor legitimo para texto (limpar o campo), mas para
    // data ou numero e so um input em branco: mandar '' para uma coluna
    // DateTime derruba a gravacao inteira.
    const naoTexto = new Set(
      (modelo?.fields ?? [])
        .filter(f => f.kind === 'scalar' && f.type !== 'String')
        .map(f => f.name),
    );

    const dados: Record<string, any> = {};
    for (const [chave, valor] of Object.entries(entrada ?? {})) {
      // `undefined` no Prisma significa "nao mexe": deixar de fora preserva o
      // que ja esta gravado, que e o esperado num update parcial.
      if (valor === undefined || !colunas.has(chave)) continue;
      if (valor === '' && naoTexto.has(chave)) continue;
      dados[chave] = valor;
    }
    return dados;
  }

  /**
   * Aceita id OU codigo em `tipo_equipamento_id` e devolve sempre o id.
   *
   * O front monta esse campo com `tipo_equipamento_id || tipo_equipamento`, e o
   * segundo e o codigo textual da coluna legada. Nos 47 equipamentos que so tem
   * o texto antigo, e um codigo que chega aqui — e a FK para
   * `tipos_equipamentos` recusaria, derrubando um salvamento que antes passava
   * (passava porque o campo era descartado; o preco era perder o modelo).
   *
   * Resolver os dois formatos faz o salvamento converter o texto legado em FK
   * de verdade, em vez de falhar ou de ignorar. Valor que nao casa com nenhum
   * dos dois vira erro com o valor no texto: melhor que uma violacao de
   * constraint opaca.
   */
  private async resolverTiposDeEquipamento(valores: string[]) {
    const buscar = [...new Set(valores.map(v => v?.trim()).filter(Boolean))];
    if (buscar.length === 0) return new Map<string, string>();

    const achados = await this.prisma.tipos_equipamentos.findMany({
      where: { OR: [{ id: { in: buscar } }, { codigo: { in: buscar } }] },
      select: { id: true, codigo: true },
    });

    const mapa = new Map<string, string>();
    for (const t of achados) {
      mapa.set(t.id.trim(), t.id.trim());
      if (t.codigo) mapa.set(t.codigo.trim(), t.id.trim());
    }

    const perdidos = buscar.filter(v => !mapa.has(v));
    if (perdidos.length > 0) {
      throw new BadRequestException(
        `Tipo de equipamento nao encontrado: ${perdidos.join(', ')}`,
      );
    }
    return mapa;
  }

  /** Mesmo DELETE+INSERT do `update`, para o lote nao ser o caminho pobre. */
  private async regravarDadosTecnicos(
    prisma: PrismaService,
    equipamentoId: string,
    dadosTecnicos?: any[],
  ) {
    if (!dadosTecnicos) return; // ausente = nao mexer; [] = apagar
    await prisma.equipamentos_dados_tecnicos.deleteMany({
      where: { equipamento_id: equipamentoId },
    });
    if (dadosTecnicos.length > 0) {
      await prisma.equipamentos_dados_tecnicos.createMany({
        data: dadosTecnicos.map(dt => ({ equipamento_id: equipamentoId, ...dt })),
      });
    }
  }

  async salvarComponentesUARLote(ucId: string, componentes: Partial<CreateEquipamentoDto & { id?: string }>[]) {
    const equipamentoUC = await this.prisma.equipamentos.findFirst({
      where: { id: ucId.trim(), deleted_at: null, classificacao: 'UC' }
    });

    if (!equipamentoUC) {
      throw new NotFoundException('Equipamento UC não encontrado');
    }

    // 1. Buscar componentes existentes no banco
    const componentesExistentes = await this.prisma.equipamentos.findMany({
      where: {
        equipamento_pai_id: ucId.trim(),
        deleted_at: null,
      },
      select: { id: true }
    });

    const idsExistentes = componentesExistentes.map(c => c.id.trim());
    const idsRecebidos = componentes
      .map(c => (c as any).id?.trim())
      .filter(Boolean); // Remove undefined/null

    // 2. Identificar componentes a serem excluídos (soft delete)
    const idsParaExcluir = idsExistentes.filter(id => !idsRecebidos.includes(id));

    if (idsParaExcluir.length > 0) {
      await this.prisma.equipamentos.updateMany({
        where: {
          id: { in: idsParaExcluir },
        },
        data: {
          deleted_at: new Date(),
        },
      });
    }

    // 3. Criar/Atualizar componentes
    const resultados = [];

    const tipos = await this.resolverTiposDeEquipamento(
      componentes.map(c => (c as any).tipo_equipamento_id),
    );

    for (const componente of componentes) {
      const componenteId = (componente as any).id?.trim();
      const { dados_tecnicos } = componente;

      const campos = this.camposGravaveisDoEquipamento(componente);
      if (campos.tipo_equipamento_id) {
        campos.tipo_equipamento_id = tipos.get(String(campos.tipo_equipamento_id).trim());
      }

      const baseData = {
        ...campos,
        classificacao: 'UAR' as const,
        equipamento_pai_id: ucId.trim(),
        unidade_id: equipamentoUC.unidade_id,
      };

      if (componenteId && !componenteId.startsWith('temp_')) {
        // Atualizar componente existente
        const atualizado = await this.prisma.equipamentos.update({
          where: { id: componenteId },
          data: baseData,
        });
        await this.regravarDadosTecnicos(this.prisma, componenteId, dados_tecnicos);
        resultados.push(atualizado);
      } else {
        // Criar novo componente
        const criado = await this.prisma.equipamentos.create({
          data: baseData as any,
        });
        await this.regravarDadosTecnicos(this.prisma, criado.id.trim(), dados_tecnicos);
        resultados.push(criado);
      }
    }

    return {
      message: `${resultados.length} componentes processados com sucesso`,
      componentes: resultados
    };
  }

  async findByUnidade(unidadeId: string, query: EquipamentoQueryDto, user?: ScopedUser) {
    // Verificar se unidade existe
    const unidadeExists = await this.prisma.unidades.findFirst({
      where: { id: unidadeId, deleted_at: null },
      include: {
        planta: {
          select: {
            id: true,
            nome: true,
            localizacao: true,
          }
        }
      }
    });

    if (!unidadeExists) {
      throw new NotFoundException('Unidade não encontrada');
    }

    // Scope RBAC: 403 se a planta da unidade nao esta no escopo do usuario
    await this.scopeService.assertPlantaInScope(unidadeExists.planta_id, user);

    // Usar o método findAll existente com filtro de unidade
    // Remove planta_id se existir, pois quando temos unidade_id não precisamos de planta_id
    const { planta_id, ...queryRestante } = query;
    const queryComUnidade = {
      ...queryRestante,
      unidade_id: unidadeId
    };

    const resultado = await this.findAll(queryComUnidade, user);

    return {
      ...resultado,
      unidade: {
        id: unidadeExists.id,
        nome: unidadeExists.nome,
        planta: unidadeExists.planta,
      }
    };
  }

  async getEstatisticasUnidade(unidadeId: string) {
    // Verificar se unidade existe
    const unidade = await this.prisma.unidades.findFirst({
      where: { id: unidadeId, deleted_at: null },
      include: {
        planta: {
          select: {
            id: true,
            nome: true,
            localizacao: true,
          }
        }
      }
    });

    if (!unidade) {
      throw new NotFoundException('Unidade não encontrada');
    }

    const [
      totalEquipamentos,
      equipamentosPorTipo,
      equipamentosPorCriticidade,
      valorTotal,
      equipamentosUC,
      componentesUAR
    ] = await Promise.all([
      // Total de equipamentos
      this.prisma.equipamentos.count({
        where: { unidade_id: unidadeId, deleted_at: null }
      }),

      // Por tipo
      this.prisma.equipamentos.groupBy({
        by: ['classificacao'],
        where: { unidade_id: unidadeId, deleted_at: null },
        _count: { id: true }
      }),

      // Por criticidade
      this.prisma.equipamentos.groupBy({
        by: ['criticidade'],
        where: { unidade_id: unidadeId, deleted_at: null },
        _count: { id: true }
      }),

      // Valor total
      this.prisma.equipamentos.aggregate({
        where: {
          unidade_id: unidadeId,
          deleted_at: null,
          valor_contabil: { not: null }
        },
        _sum: { valor_contabil: true }
      }),

      // Contagem UCs
      this.prisma.equipamentos.count({
        where: {
          unidade_id: unidadeId,
          deleted_at: null,
          classificacao: 'UC'
        }
      }),

      // Contagem UARs
      this.prisma.equipamentos.count({
        where: {
          unidade_id: unidadeId,
          deleted_at: null,
          classificacao: 'UAR'
        }
      })
    ]);

    // Formatar dados de criticidade
    const criticidadeMap = equipamentosPorCriticidade.reduce((acc, item) => {
      acc[item.criticidade] = item._count.id;
      return acc;
    }, {} as Record<string, number>);

    return {
      unidade: {
        id: unidade.id,
        nome: unidade.nome,
        planta: unidade.planta,
      },
      totais: {
        equipamentos: totalEquipamentos,
        equipamentosUC,
        componentesUAR,
      },
      porCriticidade: {
        '1': criticidadeMap['1'] || 0,
        '2': criticidadeMap['2'] || 0,
        '3': criticidadeMap['3'] || 0,
        '4': criticidadeMap['4'] || 0,
        '5': criticidadeMap['5'] || 0,
      },
      financeiro: {
        valorTotalContabil: Number(valorTotal._sum.valor_contabil || 0),
      }
    };
  }

  /**
   * Cria um componente visual (BARRAMENTO ou PONTO) para uso em diagramas
   */
  async criarComponenteVisual(unidadeId: string, tipo: 'BARRAMENTO' | 'PONTO', nome?: string) {
    // Verificar se unidade existe
    const unidade = await this.prisma.unidades.findFirst({
      where: { id: unidadeId, deleted_at: null }
    });

    if (!unidade) {
      throw new NotFoundException('Unidade não encontrada');
    }

    // Criar equipamento virtual
    const equipamento = await this.prisma.equipamentos.create({
      data: {
        nome: nome || `${tipo} ${Date.now()}`,
        classificacao: 'UAR', // Componentes virtuais são UAR
        unidade_id: unidadeId,
        criticidade: '1', // Criticidade mínima (não representa equipamento real)
        tipo_equipamento: tipo, // BARRAMENTO ou PONTO
        localizacao: 'VIRTUAL', // Marca como componente virtual
      },
      select: {
        id: true,
        nome: true,
        tipo_equipamento: true,
        unidade_id: true,
      }
    });

    // IMPORTANTE: Fazer trim de todos os campos porque o banco pode ter CHAR() em vez de VARCHAR()
    return {
      id: equipamento.id?.trim(),
      nome: equipamento.nome?.trim(),
      tipo_equipamento: equipamento.tipo_equipamento?.trim(),
      unidade_id: equipamento.unidade_id?.trim(),
    };
  }

  /**
   * Configura ou atualiza o tópico MQTT de um equipamento.
   *
   * Estrategia em camadas:
   *   1) Atualiza o banco (fonte da verdade).
   *   2) Se IMqttBroker estiver provido, chama subscribe/unsubscribe direto (sincronizacao imediata).
   *   3) Sempre emite EQUIPAMENTO_MQTT_CHANGED para que listeners reajam (e a reconciliacao
   *      periodica corrija qualquer drift). Por isso esta rota nao depende mais
   *      obrigatoriamente do MQTT_BROKER estar registrado.
   */
  async configurarMqtt(id: string, dto: ConfigurarMqttDto) {
    const equipamentoAtual = await this.prisma.equipamentos.findFirst({
      where: { id, deleted_at: null },
      select: { id: true, topico_mqtt: true, mqtt_habilitado: true },
    });

    if (!equipamentoAtual) {
      throw new NotFoundException('Equipamento não encontrado');
    }

    // Normalizar topico_mqtt: string vazia / whitespace = remover -> null
    if (
      typeof dto.topico_mqtt === 'string' &&
      dto.topico_mqtt.trim() === ''
    ) {
      dto.topico_mqtt = null as any;
    }

    if (
      dto.topico_mqtt !== undefined &&
      dto.topico_mqtt !== null &&
      !this.isValidTopicoMqtt(dto.topico_mqtt)
    ) {
      throw new BadRequestException(
        'topico_mqtt invalido (rejeitado: leading/trailing slash, wildcards + ou #)',
      );
    }

    const topicoAntigo = equipamentoAtual.topico_mqtt?.trim() || null;
    const habilitadoAntigo = !!equipamentoAtual.mqtt_habilitado;

    // Caminho sincrono via broker direto (se provido)
    if (this.mqttService && habilitadoAntigo && topicoAntigo) {
      this.mqttService.removerTopico(id, topicoAntigo);
    }

    const equipamento = await this.prisma.equipamentos.update({
      where: { id },
      data: {
        topico_mqtt: dto.topico_mqtt,
        mqtt_habilitado: dto.mqtt_habilitado,
      },
    });

    const topicoNovo = equipamento.topico_mqtt?.trim() || null;
    const habilitadoNovo = !!equipamento.mqtt_habilitado;

    if (this.mqttService && habilitadoNovo && topicoNovo) {
      this.mqttService.adicionarTopico(id, topicoNovo);
    }

    // Emitir evento sempre que houve mudanca, mesmo com broker direto chamado:
    // (a) consumidores podem registrar OnEvent independente do MQTT_BROKER;
    // (b) reconcile funciona como rede de seguranca.
    if (topicoNovo !== topicoAntigo || habilitadoNovo !== habilitadoAntigo) {
      this.emitMqttChanged({
        equipamentoId: equipamento.id?.trim?.() ?? equipamento.id,
        topicoAntigo,
        topicoNovo,
        habilitado: habilitadoNovo,
      });
    }

    return {
      id: equipamento.id,
      nome: equipamento.nome,
      topico_mqtt: equipamento.topico_mqtt,
      mqtt_habilitado: equipamento.mqtt_habilitado,
      updatedAt: equipamento.updated_at,
    };
  }

  async updateFoto(id: string, filename: string) {
    const equipamento = await this.prisma.equipamentos.findFirst({
      where: { id: id.trim(), deleted_at: null },
    });

    if (!equipamento) {
      throw new NotFoundException('Equipamento nao encontrado');
    }

    // Deletar arquivo antigo se existir
    if (equipamento.foto_url) {
      try {
        const fs = require('fs').promises;
        const path = require('path');
        const oldFilePath = path.join(process.cwd(), equipamento.foto_url);
        await fs.unlink(oldFilePath).catch(() => { /* ignora se nao existir */ });
      } catch {
        // nao bloqueia update se limpeza falhar
      }
    }

    const fotoUrl = `/uploads/equipamentos/${filename}`;

    await this.prisma.equipamentos.update({
      where: { id: id.trim() },
      data: { foto_url: fotoUrl },
    });

    return { fotoUrl };
  }

  async removeFoto(id: string) {
    const equipamento = await this.prisma.equipamentos.findFirst({
      where: { id: id.trim(), deleted_at: null },
    });

    if (!equipamento) {
      throw new NotFoundException('Equipamento nao encontrado');
    }

    if (equipamento.foto_url) {
      try {
        const fs = require('fs').promises;
        const path = require('path');
        const oldFilePath = path.join(process.cwd(), equipamento.foto_url);
        await fs.unlink(oldFilePath).catch(() => { /* ignora se nao existir */ });
      } catch {
        // ignora
      }
    }

    await this.prisma.equipamentos.update({
      where: { id: id.trim() },
      data: { foto_url: null },
    });

    return { fotoUrl: null };
  }
}