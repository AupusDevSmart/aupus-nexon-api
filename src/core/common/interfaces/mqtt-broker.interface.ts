/**
 * Interface minima que um broker MQTT precisa implementar para ser usado
 * pelo EquipamentosService. Cada consumer fornece sua propria implementacao
 * (ou nao - o EquipamentosService funciona sem MQTT via @Optional).
 */
export interface IMqttBroker {
  adicionarTopico(equipamentoId: string, topico: string): void;
  removerTopico(equipamentoId: string, topico: string): void;
}

/**
 * Token de injecao para o broker MQTT. Use no @Inject() para fornecer
 * uma implementacao concreta a partir do consumer:
 *
 *   { provide: MQTT_BROKER, useClass: MyMqttService }
 */
export const MQTT_BROKER = Symbol('MQTT_BROKER');
