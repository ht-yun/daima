module.exports = {
  apps: [
    {
      name: 'codereview',
      script: 'server/index.mjs',
      cwd: __dirname,
      env: {
        APP_HOST: '0.0.0.0',
        APP_PORT: '8080',
        NODE_ENV: 'production',
      },
      autorestart: true,
      max_restarts: 20,
      restart_delay: 3000,
    },
  ],
};
