-- Pivô: pontos nativos (o cadastro do unifilar cria ao marcar SCS Comando/Status).
-- Nomes iguais aos dos pivôs da Chimarrão — a sequência (PivoSequenciaService) acha
-- os papéis pelo nome: direita / esquerda / desligar(+do) / erro.
UPDATE tipos_equipamentos
SET propriedades_schema = COALESCE(propriedades_schema, '{}'::jsonb) || jsonb_build_object('pontos_nativos', jsonb_build_object(
      'comando', jsonb_build_array(
        jsonb_build_object('id', 'girar_direita',  'label', 'Girar_direita'),
        jsonb_build_object('id', 'girar_esquerda', 'label', 'Girar_esquerda'),
        jsonb_build_object('id', 'desligar',       'label', 'Desligar')),
      'status', jsonb_build_array(
        jsonb_build_object('id', 'girando_direita',  'label', 'Girando_direita'),
        jsonb_build_object('id', 'girando_esquerda', 'label', 'Girando_esquerda'),
        jsonb_build_object('id', 'desligado',        'label', 'Desligado'),
        jsonb_build_object('id', 'erro',             'label', 'Erro')))),
    updated_at = now()
WHERE codigo = 'PIVO';
