// Explicit opt-in integration check against the production nginx configuration.
// Uses only local stubs and an ephemeral container; never sends Web Push.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const directory = await mkdtemp(join(tmpdir(), 'herm-push-proxy-'));
const seen = [];
const upstream = http.createServer((req, res) => {
  seen.push({ path: req.url, headers: req.headers });
  if (req.url === '/api/config' && req.headers.cookie !== 'session=valid' && req.headers['x-hermes-session-token'] !== 'valid') { res.writeHead(401); res.end(); return; }
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ ok: true }));
});
await new Promise(resolve => upstream.listen(0, '0.0.0.0', resolve));
const port = upstream.address().port;
const name = `herm-push-proxy-${process.pid}`;
try {
  const config = (await readFile(new URL('../../deploy/nginx.conf', import.meta.url), 'utf8')).replace('include /tmp/hermes-gateway.conf;', `upstream hermes_gateway { server host.docker.internal:${port}; }`).replaceAll('http://web-push-relay:8080', `http://host.docker.internal:${port}`);
  await writeFile(join(directory, 'nginx.conf'), config);
  execFileSync('docker', ['run', '-d', '--rm', '--name', name, '--add-host', 'host.docker.internal:host-gateway', '-p', '127.0.0.1::8080', '-v', `${directory}/nginx.conf:/etc/nginx/nginx.conf:ro`, '--entrypoint', 'nginx', 'hermes-mobile-pwa:local', '-g', 'daemon off;'], { stdio: 'pipe' });
  const address = execFileSync('docker', ['port', name, '8080/tcp'], { encoding: 'utf8' }).trim();
  const base = `http://${address}`;
  for (let i = 0; i < 30; i++) { try { if ((await fetch(`${base}/healthz`)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  const options = { method: 'POST', headers: { Cookie: 'session=valid', Origin: 'https://mobile.example', 'Content-Type': 'application/json', Authorization: 'must-not-forward' }, body: '{}' };
  for (const route of ['status', 'test']) {
    assert.equal((await fetch(`${base}/push/v1/${route}`, { ...options, headers: { 'Content-Type': 'application/json' } })).status, 401);
    const response = await fetch(`${base}/push/v1/${route}`, options);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await fetch(`${base}/push/v1/${route}`)).status, 403);
    const target = seen.find(call => call.path === `/v1/${route}`);
    assert.equal(target.headers.cookie, 'session=valid');
    assert.equal(target.headers.origin, 'https://mobile.example');
    assert.equal(target.headers.authorization, undefined);
  }
  assert.equal((await fetch(`${base}/push/v1/test`, { ...options, body: 'x'.repeat(33000) })).status, 413);
  const tokenResponse = await fetch(`${base}/push/v1/status`, { ...options, headers: { 'X-Hermes-Session-Token': 'valid', 'Content-Type': 'application/json' } });
  assert.equal(tokenResponse.status, 200);
  assert(seen.some(call => call.path === '/v1/status' && call.headers['x-hermes-session-token'] === 'valid'));
  console.log('nginx push proxy integration passed: auth, methods, credentials, no-store, body limits and exact relay routes');
} finally {
  try { execFileSync('docker', ['rm', '-f', name], { stdio: 'pipe' }); } catch {}
  await new Promise(resolve => upstream.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
