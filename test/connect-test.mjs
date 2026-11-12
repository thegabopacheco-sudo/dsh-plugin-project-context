// Test end-to-end de project-context con proyecto sintético.
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const packageDir = path.resolve(import.meta.dirname, '..');
const tmpDir = path.join(packageDir, 'test', 'tmp');
rmSync(tmpDir, { recursive: true, force: true });
const home = path.join(tmpDir, 'dsh-home');
const project = path.join(tmpDir, 'demo-app');
mkdirSync(path.join(project, 'src'), { recursive: true });
mkdirSync(path.join(home, 'project-context'), { recursive: true });
writeFileSync(path.join(home, 'project-context', 'config.json'), JSON.stringify({ allowedPaths: [project] }), 'utf8');
writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'demo-app', version: '1.2.3', scripts: { dev: 'node src/app.js', build: 'node build.js' }, dependencies: { react: '^18.0.0', express: '^4.0.0' }, type: 'module' }), 'utf8');
writeFileSync(path.join(project, 'README.md'), '# Demo\n\nProyecto de prueba para context pack.\n', 'utf8');
writeFileSync(path.join(project, 'src', 'app.js'), 'console.log("hola");\n', 'utf8');
writeFileSync(path.join(project, 'Dockerfile'), 'FROM node:22\n', 'utf8');
writeFileSync(path.join(project, '.env.example'), 'PORT=3000\n', 'utf8');
mkdirSync(path.join(project, 'node_modules', 'x'), { recursive: true });
writeFileSync(path.join(project, 'node_modules', 'x', 'index.js'), 'ignorado', 'utf8');

function makeClient(extraEnv = {}) {
  const entry = process.env.PROJECTCTX_SERVER ? path.resolve(process.env.PROJECTCTX_SERVER) : path.join(packageDir, 'server.mjs');
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], env: { SystemRoot: process.env.SystemRoot || 'C:\\Windows', PATH: process.env.PATH, USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME || process.env.USERPROFILE, TEMP: process.env.TEMP, TMP: process.env.TMP, DSH_HOME: home, ...extraEnv }, stderr: 'pipe' });
  transport.stderr?.on('data', (c) => process.stderr.write(`[server] ${c}`));
  const client = new Client({ name: 'projectctx-test', version: '1.0.0' }, { capabilities: {}, versionNegotiation: { mode: 'auto' } });
  return client.connect(transport).then(() => ({ client, transport }));
}
const textOf = (r) => (r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');

const { client, transport } = await makeClient();
console.log('tools:', (await client.listTools()).tools.map((t) => t.name).join(', '));
console.log('--- status ---'); console.log(textOf(await client.callTool({ name: 'status', arguments: {} })));
const pack = textOf(await client.callTool({ name: 'scan', arguments: { path: project } }));
console.log('--- scan (recorte) ---'); console.log(pack.slice(0, 1200));
console.log('nombre y versión:', pack.includes('demo-app') && pack.includes('1.2.3'));
console.log('stack node/react/express/docker:', pack.includes('Node.js') && pack.includes('react') && pack.includes('Docker'));
console.log('scripts:', pack.includes('dev') && pack.includes('build'));
console.log('README:', pack.includes('Proyecto de prueba para context pack'));
console.log('ignora node_modules:', !pack.includes('node_modules'));
console.log('sin git lo dice:', pack.includes('no es un repo git') || pack.includes('Git:'));
const outside = await client.callTool({ name: 'scan', arguments: { path: 'C:\\Windows' } });
console.log('fuera de allowedPaths isError:', outside.isError === true);
const noConfirm = await client.callTool({ name: 'save', arguments: { path: project } });
console.log('save sin confirm isError:', noConfirm.isError === true);
const saved = await client.callTool({ name: 'save', arguments: { path: project, confirm: true } });
const savedText = textOf(saved);
console.log('--- save ---'); console.log(savedText);
const file = savedText.replace('Contexto guardado: ', '').split(' (')[0];
console.log('archivo existe y contiene pack:', existsSync(file) && readFileSync(file, 'utf8').includes('demo-app'));
const saved2 = textOf(await client.callTool({ name: 'save', arguments: { path: project, confirm: true } }));
console.log('segundo save no sobrescribe:', saved2 !== savedText);
await client.close(); try { await transport.close?.(); } catch {}
const { client: roClient, transport: roTransport } = await makeClient({ DSH_PROJECTCTX_MODE: 'read-only' });
const roSave = await roClient.callTool({ name: 'save', arguments: { path: project, confirm: true } });
console.log('read-only save isError:', roSave.isError === true);
const roScan = await roClient.callTool({ name: 'scan', arguments: { path: project } });
console.log('read-only scan ok:', roScan.isError !== true);
await roClient.close(); try { await roTransport.close?.(); } catch {}
console.log('OK');
