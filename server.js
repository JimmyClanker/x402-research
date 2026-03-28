import { createApp } from './app.js';

const { app, config, services } = createApp();

function shutdown() {
  console.log('Shutting down...');
  services.signals.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Retry listen with backoff to handle EADDRINUSE from rapid launchd restarts
function listen(attempt = 1) {
  const server = app.listen(config.port, () => {
    console.log(`${config.appName} v${config.version} on port ${config.port}`);
    console.log('REST: /research, /fetch (rate limited: 30/min)');
    console.log(`MCP:  /mcp (Streamable HTTP, ${config.mcpAuthKey ? 'auth required' : 'open'})`);
    console.log(`Storage: SQLite (${config.dbPath})`);
    console.log(`Environment: ${config.nvmEnv}`);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempt <= 5) {
      console.log(`Port ${config.port} busy, retry ${attempt}/5 in ${attempt * 2}s...`);
      setTimeout(() => listen(attempt + 1), attempt * 2000);
    } else {
      console.error(err);
      process.exit(1);
    }
  });
}

listen();
