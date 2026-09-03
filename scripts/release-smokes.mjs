import { spawn } from 'node:child_process';
import { once } from 'node:events';

const npm = 'npm';
const server = spawn(process.execPath, ['dist/server/index.js'], {
  env: { ...process.env, NODE_ENV: 'test', PORT: '3001' },
  stdio: 'inherit',
});

let serverExited = false;
server.once('exit', () => { serverExited = true; });

try {
  await waitForServer();
  for (const script of [
    'smoke:runtime',
    'smoke:reconnect',
    'smoke:signal',
    'smoke:http',
    'stress:actions',
    'stress:socket',
  ]) await runNpmScript(script);
} finally {
  if (!serverExited) {
    server.kill('SIGTERM');
    await Promise.race([once(server, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
    if (!serverExited) server.kill('SIGKILL');
  }
}

async function waitForServer() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (serverExited) throw new Error('The release smoke server exited before becoming healthy.');
    try {
      const response = await fetch('http://127.0.0.1:3001/api/health');
      if (response.ok) return;
    } catch {
      // The process can take a moment to bind on slower release machines.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('The release smoke server did not become healthy within 30 seconds.');
}

async function runNpmScript(script) {
  const child = spawn(npm, ['run', script], { stdio: 'inherit', shell: process.platform === 'win32' });
  const [code, signal] = await once(child, 'exit');
  if (code !== 0) throw new Error(`${script} failed${signal ? ` with ${signal}` : ` with exit code ${code}`}.`);
}
