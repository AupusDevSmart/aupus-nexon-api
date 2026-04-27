// PM2 ecosystem - aupus-nexon-api (producao)
// Uso: pm2 start ecosystem.config.cjs   (rodar a partir da raiz do projeto)
// PM2 usa o cwd onde este arquivo vive, entao nao hardcoded paths absolutos.
module.exports = {
  apps: [
    {
      name: 'aupus-nexon-api',
      script: 'dist/src/main.js',
      instances: 1,            // fork mode: subscriptions MQTT nao podem multiplicar
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '1G',
      merge_logs: true,
      time: true,
      out_file: 'logs/out.log',
      error_file: 'logs/error.log',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
