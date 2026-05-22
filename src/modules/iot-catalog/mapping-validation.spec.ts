import {
  formatMappingIssues,
  validateMapeamento,
} from './mapping-validation';

describe('validateMapeamento', () => {
  it('1. retorna [] quando map eh null', () => {
    expect(validateMapeamento(null)).toEqual([]);
  });

  it('1b. retorna [] quando map eh undefined', () => {
    expect(validateMapeamento(undefined)).toEqual([]);
  });

  it('2. retorna [] quando map eh objeto vazio {}', () => {
    expect(validateMapeamento({})).toEqual([]);
  });

  it('3. retorna issue quando map eh string', () => {
    const issues = validateMapeamento('not-an-object');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('objeto JSON');
  });

  it('3b. retorna issue quando map eh array', () => {
    const issues = validateMapeamento([]);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('objeto JSON');
  });

  it('4. aceita ai_blocks bem formado', () => {
    const map = {
      ai_blocks: [
        { start: 5000, count: 50, func: 0x04, label: 'X' },
        { start: 7012, count: 18, func: 0x04 },
      ],
    };
    expect(validateMapeamento(map)).toEqual([]);
  });

  it('5. retorna issue quando ai_blocks eh string', () => {
    const issues = validateMapeamento({ ai_blocks: 'invalid' });
    expect(issues.some((i) => i.path === 'ai_blocks')).toBe(true);
  });

  it('6. retorna issue quando bloco tem start nao-numerico', () => {
    const issues = validateMapeamento({
      ai_blocks: [{ start: '5000', count: 50 }],
    });
    expect(issues.some((i) => i.path === 'ai_blocks[0].start')).toBe(true);
  });

  it('7. retorna issue quando bloco tem count <= 0', () => {
    const issues = validateMapeamento({
      ai_blocks: [{ start: 5000, count: 0 }],
    });
    expect(issues.some((i) => i.path === 'ai_blocks[0].count')).toBe(true);
  });

  it('8. retorna issue quando bloco tem func nao-numerico', () => {
    const issues = validateMapeamento({
      ai_blocks: [{ start: 5000, count: 50, func: 'invalid' }],
    });
    expect(issues.some((i) => i.path === 'ai_blocks[0].func')).toBe(true);
  });

  it('9. retorna issue quando ai_map.X.block fora do range de ai_blocks', () => {
    const issues = validateMapeamento({
      ai_blocks: [{ start: 5000, count: 50, func: 0x04 }],
      ai_map: { foo: { block: 99, offset: 0, dataType: 'U16' } },
    });
    const blockIssue = issues.find((i) => i.path === 'ai_map.foo.block');
    expect(blockIssue).toBeDefined();
    expect(blockIssue!.message).toContain('fora do range');
  });

  it('10. retorna issue quando ai_map.X.offset eh negativo', () => {
    const issues = validateMapeamento({
      ai_blocks: [{ start: 5000, count: 50, func: 0x04 }],
      ai_map: { foo: { block: 0, offset: -1, dataType: 'U16' } },
    });
    expect(issues.some((i) => i.path === 'ai_map.foo.offset')).toBe(true);
  });

  it('11. retorna issue quando ai_map.X.offset estoura count do bloco', () => {
    const issues = validateMapeamento({
      ai_blocks: [{ start: 5000, count: 50, func: 0x04 }],
      ai_map: { foo: { block: 0, offset: 60, dataType: 'U16' } },
    });
    const offsetIssue = issues.find((i) => i.path === 'ai_map.foo.offset');
    expect(offsetIssue).toBeDefined();
    expect(offsetIssue!.message).toContain('estoura');
  });

  it('12. retorna issue quando dataType eh invalido', () => {
    const issues = validateMapeamento({
      ai_map: { foo: { dataType: 'FLOAT64' } },
    });
    const dtIssue = issues.find((i) => i.path === 'ai_map.foo.dataType');
    expect(dtIssue).toBeDefined();
    expect(dtIssue!.message).toContain('U16');
  });

  it('13. retorna issue quando mode eh invalido', () => {
    const issues = validateMapeamento({
      ai_map: { foo: { mode: 'min' } },
    });
    expect(issues.some((i) => i.path === 'ai_map.foo.mode')).toBe(true);
  });

  it('14. retorna issue quando apply_factor eh invalido', () => {
    const issues = validateMapeamento({
      ai_map: { foo: { apply_factor: 'xyz' } },
    });
    expect(issues.some((i) => i.path === 'ai_map.foo.apply_factor')).toBe(true);
  });

  it('15. valida bi_map e bo_map com mesmas regras de ai_map', () => {
    const issues = validateMapeamento({
      ai_blocks: [{ start: 0, count: 10, func: 0x01 }],
      bi_map: { x: { block: 5, offset: 0 } }, // block fora do range
      bo_map: { y: { block: 0, offset: 100 } }, // offset estoura
    });
    expect(issues.some((i) => i.path.startsWith('bi_map'))).toBe(true);
    expect(issues.some((i) => i.path.startsWith('bo_map'))).toBe(true);
  });

  it('16. caso real Sungrow SG250CX nao gera issues', () => {
    // Subset do mapping real (ai_blocks + alguns campos do ai_map)
    const map = {
      catalog_id: 'sungrow-sg250cx',
      num_mppts: 12,
      num_strings: 24,
      word_order: 'low_first',
      ai_blocks: [
        { start: 4999, count: 50, func: 0x04, label: 'Regs 5000-5049' },
        { start: 5049, count: 40, func: 0x04, label: 'Regs 5050-5089' },
        { start: 5089, count: 30, func: 0x04, label: 'Regs 5090-5119' },
        { start: 5119, count: 35, func: 0x04, label: 'Regs 5120-5154' },
        { start: 7012, count: 18, func: 0x04, label: 'Regs 7013-7030' },
      ],
      ai_map: {
        nominal_power: { block: 0, offset: 1, scale: 10, dataType: 'U16', mode: 'last' },
        daily_yield: { block: 0, offset: 3, scale: 10, dataType: 'U16', mode: 'last' },
        total_yield: { block: 0, offset: 4, scale: 1, dataType: 'U32', mode: 'last' },
        mppt1_voltage: { block: 0, offset: 11, scale: 10, dataType: 'U16', mode: 'avg' },
        potencia_ativa: { block: 0, offset: 31, scale: 1, dataType: 'U32', mode: 'last' },
        fp: { block: 0, offset: 35, scale: 1000, dataType: 'S16', mode: 'last' },
        string1_current: { block: 4, offset: 0, scale: 100, dataType: 'U16', mode: 'avg' },
      },
      bi_map: {
        work_state: { register: 5038, func: 0x04 },
      },
      bo_map: {},
    };
    expect(validateMapeamento(map)).toEqual([]);
  });
});

describe('formatMappingIssues', () => {
  it('formata issues com path em colchetes', () => {
    const txt = formatMappingIssues([
      { path: 'ai_blocks[0].start', message: 'start deve ser numero' },
      { path: 'ai_map.foo.block', message: 'block=99 fora do range' },
    ]);
    expect(txt).toBe(
      '[ai_blocks[0].start] start deve ser numero; [ai_map.foo.block] block=99 fora do range',
    );
  });

  it('formata issue sem path apenas com message', () => {
    const txt = formatMappingIssues([{ path: '', message: 'mapeamento deve ser objeto' }]);
    expect(txt).toBe('mapeamento deve ser objeto');
  });

  it('retorna string vazia se issues vazio', () => {
    expect(formatMappingIssues([])).toBe('');
  });
});
