module.exports = {
  apps: [{
    name: 'semantic-cms',
    script: 'server.js',
    instances: 1,
    autorestart: true,
    watch: false,
    env_production: {
      NODE_ENV: 'production',
      PORT: 3000,
    },
  }],
}
