// PM2 entry para o aupus-firmware-compiler.
// Rodado via:   pm2 startOrReload firmware-compiler/ecosystem.config.cjs --update-env
// Pasta cwd:    /var/www/service-nexon/aupus-nexon-api/firmware-compiler/
module.exports = {
  apps: [
    {
      name: 'aupus-firmware-compiler',
      script: 'server.js',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        PORT: '3211',
        ARTIFACTS_PUBLIC_PATH: '/iot-compile/artifacts',
      },
      // PlatformIO precisa de HOME apontando para onde /root/.platformio/ esta.
      // Em prod o pm2 roda como root, entao HOME ja eh /root — nao precisa override.
    },
  ],
};
