export interface InversorMqttData {
  timestamp: number;
  inverter_id: number;
  info: {
    device_type: string;
    nominal_power: number;
    output_type: number;
  };
  energy: {
    daily_yield: number;
    total_yield: number;
    total_running_time: number;
    Potencia_Aparente1: number;
    Potencia_Aparente2: number;
    daily_running_time: number;
  };
  temperature: {
    internal: number;
  };
  dc: {
    mppt1_voltage: number;
    mppt2_voltage: number;
    mppt3_voltage: number;
    mppt4_voltage: number;
    mppt5_voltage: number;
    mppt6_voltage: number;
    mppt7_voltage: number;
    mppt8_voltage: number;
    mppt9_voltage: number;
    mppt10_voltage: number;
    mppt11_voltage: number;
    mppt12_voltage: number;
    string1_current: number;
    string2_current: number;
    string3_current: number;
    string4_current: number;
    string5_current: number;
    string6_current: number;
    string7_current: number;
    string8_current: number;
    string9_current: number;
    string10_current: number;
    string11_current: number;
    string12_current: number;
    string13_current: number;
    string14_current: number;
    string15_current: number;
    string16_current: number;
    string17_current: number;
    string18_current: number;
    string19_current: number;
    string20_current: number;
    string21_current: number;
    string22_current: number;
    string23_current: number;
    string24_current: number;
    total_power: number;
  };
  voltage: {
    'phase_a-b': number;
    'phase_b-c': number;
    'phase_c-a': number;
  };
  current: {
    phase_a: number;
    phase_b: number;
    phase_c: number;
  };
  power: {
    active_total: number;
    reactive_total: number;
    apparent_total: number;
    power_factor: number;
    frequency: number;
  };
  status: {
    work_state: number;
    work_state_text: string;
  };
  protection: {
    insulation_resistance: number;
    bus_voltage: number;
  };
  regulation: {
    nominal_reactive_power: number;
  };
  pid: {
    work_state: number;
    alarm_code: number;
  };
}
