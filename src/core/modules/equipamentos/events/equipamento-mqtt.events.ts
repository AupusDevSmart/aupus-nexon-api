/**
 * Eventos emitidos pelo EquipamentosService quando topico_mqtt ou mqtt_habilitado
 * mudam (create/update/remove). O consumidor (ex.: aupus-nexon-api MqttService)
 * registra um @OnEvent(EQUIPAMENTO_MQTT_CHANGED) para reagir.
 *
 * O evento e emitido APOS o commit da transacao Prisma para evitar disparos
 * em updates que sofreram rollback.
 */
export const EQUIPAMENTO_MQTT_CHANGED = 'equipamento.mqtt.changed';

export interface EquipamentoMqttChangedPayload {
  equipamentoId: string;
  topicoAntigo: string | null;
  topicoNovo: string | null;
  habilitado: boolean;
}
