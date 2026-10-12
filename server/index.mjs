import { createServer } from 'node:http';
import { createHandler } from './app.mjs';
import { loadProviderEnv } from './config.mjs';

const development = process.argv.includes('--dev');
const vite = development ? await (await import('vite')).createServer({
  server: { middlewareMode: true }, appType: 'spa',
}) : undefined;
const server = createServer(createHandler({ frontend: vite?.middlewares, getProviderEnv: loadProviderEnv }));
server.listen(Number(process.env.PORT || 5173), process.env.HOST || '127.0.0.1', () => {
  console.log(`Between is ready at http://localhost:${process.env.PORT || 5173}`);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  await vite?.close();
  server.close(() => process.exit(0));
});
