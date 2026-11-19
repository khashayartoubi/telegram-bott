module.exports = {
  apps: [
    {
      name: 'telegram-bot-dev',
      script: 'src/bot.js',
      watch: ['src'],
      ignore_watch: ['node_modules', 'data', 'logs'],
      watch_delay: 500,
      env_development: {
        NODE_ENV: 'development',
      },
    },
  ],
};
