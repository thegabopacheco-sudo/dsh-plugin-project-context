#!/usr/bin/env node
// dsh-plugin-project-context — genera un pack de contexto de un proyecto local.
// Tools: status, scan, save.

import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const VERSION = '0.1.0';
const DSH_HOME = (() => {
  const v = process.env.DSH_HOME && process.env.DSH_HOME.trim();
  return v || path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.dsh');
})();
const CONFIG_FILE = path.join(DSH_HOME, 'project-context', 'config.json');
const CACHE_DIR = path.join(DSH_HOME, 'cache', 'project-context');
const READ_ONLY = String(process.env.DSH_PROJECTCTX_MODE || '').toLowerCase() === 'read-only';
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.venv', 'venv', '__pycache__', '.cache', 'target', 'coverage', '.idea', '.vscode', 'vendor']);
const log = (m) => process.stderr.write(`[projectctx] ${m}\n`);

function loadConfig() {
  try { if (existsSync(CONFIG_FILE)) return { allowedPaths: [], ...(JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) || {}) }; } catch { /* defaults */ }
  return { allowedPaths: [] };
}
function allowedRoots() {
  const configured = loadConfig().allowedPaths;
  const defaults = [process.env.USERPROFILE || process.env.HOME || os.homedir()];
  return (Array.isArray(configured) && configured.length ? configured : defaults).map((item) => path.resolve(item));
}
function isAllowed(target) {
  const resolved = path.resolve(target);
  return allowedRoots().some((root) => resolved === root || resolved.startsWith(root + path.sep));
}
function isAllowedOutput(target) {
  const resolved = path.resolve(target);
  return resolved === CACHE_DIR || resolved.startsWith(CACHE_DIR + path.sep) || isAllowed(resolved);
}
function uniquePath(target) {
  if (!existsSync(target)) return target;
  const parsed = path.parse(target);
  for (let index = 1; index < 1000; index++) {
    const candidate = path.join(parsed.dir, `${parsed.name}-${index}${parsed.ext}`);
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error('no se pudo generar un nombre único');
}
function readJson(file) { try { return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } }
function readHead(file, max = 800) { try { return readFileSync(file, 'utf8').replace(/\r/g, '').slice(0, max); } catch { return null; } }
function run(cmd, args, cwd, timeout = 4000) {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (result.error || result.status !== 0) return null;
  return (result.stdout || '').trim();
}

function scanProject(rootInner) {
  const root = path.resolve(rootInner);
  if (!existsSync(root)) throw new Error(`la ruta no existe: ${root}`);
  const stat = statSync(root);
  if (!stat.isDirectory()) throw new Error(`no es un directorio: ${root}`);
  if (!isAllowed(root)) throw new Error(`ruta no permitida: ${root} (revisa allowedPaths)`);

  const manifest = { packageJson: null, pyproject: false, requirements: false, cargo: false, go: false };
  const packageJsonFile = path.join(root, 'package.json');
  if (existsSync(packageJsonFile)) {
    const pkg = readJson(packageJsonFile);
    if (pkg) manifest.packageJson = { name: pkg.name || null, version: pkg.version || null, scripts: Object.keys(pkg.scripts || {}), dependencies: Object.keys(pkg.dependencies || {}).length, devDependencies: Object.keys(pkg.devDependencies || {}).length, engines: pkg.engines || null };
  }
  manifest.pyproject = existsSync(path.join(root, 'pyproject.toml'));
  manifest.requirements = existsSync(path.join(root, 'requirements.txt'));
  manifest.cargo = existsSync(path.join(root, 'Cargo.toml'));
  manifest.go = existsSync(path.join(root, 'go.mod'));
  const docker = existsSync(path.join(root, 'Dockerfile')) || existsSync(path.join(root, 'docker-compose.yml')) || existsSync(path.join(root, 'compose.yaml'));

  const readmeFile = ['README.md', 'README.MD', 'readme.md', 'README.txt'].map((name) => path.join(root, name)).find((file) => existsSync(file));
  const readme = readmeFile ? readHead(readmeFile, 800) : null;

  const topEntries = (() => { try { return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.name !== '.git' && !SKIP.has(entry.name)).slice(0, 40).map((entry) => `${entry.isDirectory() ? '📁' : '📄'} ${entry.name}`); } catch { return []; } })();

  const recent = [];
  let fileCount = 0;
  let totalBytes = 0;
  const walk = (dir, depth) => {
    if (depth > 3 || fileCount > 5000) return;
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (!SKIP.has(entry.name)) walk(full, depth + 1); continue; }
      try {
        const fileStat = statSync(full);
        fileCount++;
        totalBytes += fileStat.size;
        recent.push({ file: path.relative(root, full), size: fileStat.size, mtime: fileStat.mtimeMs });
      } catch { /* ignora */ }
    }
  };
  walk(root, 1);
  recent.sort((a, b) => b.mtime - a.mtime);

  const gitBranch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], root);
  const gitStatus = run('git', ['status', '--porcelain'], root);
  const gitLast = run('git', ['log', '-1', '--format=%h %s'], root);
  const stack = [];
  if (manifest.packageJson) {
    stack.push('Node.js');
    const pub = readJson(packageJsonFile) || {};
    for (const framework of ['react', 'next', 'vite', 'express', 'fastify', 'vue', 'svelte', 'electron']) if (pub.dependencies?.[framework] || pub.devDependencies?.[framework]) stack.push(framework);
    if (pub.type === 'module') stack.push('ESM');
  }
  if (manifest.pyproject || manifest.requirements) stack.push('Python');
  if (manifest.cargo) stack.push('Rust');
  if (manifest.go) stack.push('Go');
  if (docker) stack.push('Docker');
  if (readme) stack.push('docs');

  return { root, manifest, readme, topEntries, recent: recent.slice(0, 12), fileCount, totalBytes, gitBranch, gitStatus, gitLast, stack, docker };
}

function buildPack(info) {
  const lines = [
    `# Contexto de proyecto: ${path.basename(info.root)}`,
    '',
    `- **Ruta:** ${info.root}`,
    `- **Stack:** ${info.stack.length ? [...new Set(info.stack)].join(', ') : 'no detectado'}`,
    `- **Archivos:** ${info.fileCount} · ${(info.totalBytes / 1024 / 1024).toFixed(1)} MB`,
    info.gitBranch ? `- **Git:** rama ${info.gitBranch}${info.gitStatus ? ` · ${info.gitStatus.split('\n').length} cambios sin commit` : ' · limpio'}` : '- **Git:** no es un repo git o git no disponible',
  ];
  if (info.manifest.packageJson) {
    const manifest = info.manifest.packageJson;
    lines.push('', '## package.json', `- Nombre: ${manifest.name || '(sin nombre)'}`, `- Versión: ${manifest.version || '?'}`, `- Scripts: ${manifest.scripts.length ? manifest.scripts.join(', ') : 'ninguno'}`, `- Dependencias: ${manifest.dependencies} · dev: ${manifest.devDependencies}`, manifest.engines ? `- Engines: ${JSON.stringify(manifest.engines)}` : '');
  }
  const otherManifests = [info.manifest.pyproject ? 'pyproject.toml' : null, info.manifest.requirements ? 'requirements.txt' : null, info.manifest.cargo ? 'Cargo.toml' : null, info.manifest.go ? 'go.mod' : null, info.docker ? 'Docker' : null].filter(Boolean);
  if (otherManifests.length) lines.push('', `## Otros manifiestos`, `- ${otherManifests.join(', ')}`);
  if (info.readme) lines.push('', '## README (inicio)', info.readme, '');
  if (info.topEntries.length) lines.push('', '## Estructura (raíz)', ...info.topEntries.map((entry) => `- ${entry}`));
  if (info.recent.length) lines.push('', '## Archivos recientes', ...info.recent.map((file) => `- ${file.file} (${(file.size / 1024).toFixed(1)} KB)`));
  if (info.gitLast) lines.push('', '## Último commit', info.gitLast);
  if (info.gitStatus) lines.push('', '## Cambios sin commit', '```', info.gitStatus.split('\n').slice(0, 20).join('\n'), '```');
  return lines.join('\n');
}
function textResult(text) { return { content: [{ type: 'text', text }] }; }

function buildInstructions() {
  return [
    'Project Context: genera un pack de contexto de un proyecto local.',
    '',
    `Salida: ${CACHE_DIR}`,
    '',
    'Herramientas: status, scan, save.',
    '',
    'Reglas:',
    '- scan es solo lectura; save escribe y requiere confirm:true.',
    '- Respeta allowedPaths (config del plugin); nunca sobrescribe (sufijo único).',
    '- No leas dependencias instaladas ni .git: solo estructura, manifiestos, README y estado git.',
    '- Reporta lo real; si falta git o manifiestos, lo indica.',
  ].join('\n');
}

function buildServer() {
  const server = new McpServer({ name: 'dsh-plugin-project-context', version: VERSION }, { capabilities: { tools: {} }, instructions: buildInstructions() });

  server.registerTool(
    'status',
    { title: 'Estado', description: 'Rutas permitidas y salida por defecto.', inputSchema: z.object({}) },
    async () => textResult([`Rutas permitidas: ${allowedRoots().join(', ')}`, `Salida por defecto: ${CACHE_DIR}`, `Modo: ${READ_ONLY ? 'read-only' : 'normal'}`].join('\n')),
  );

  server.registerTool(
    'scan',
    { title: 'Escanear proyecto', description: 'Devuelve el pack de contexto Markdown sin escribir.', inputSchema: z.object({ path: z.string().min(2) }) },
    async (args) => textResult(buildPack(scanProject(args.path))),
  );

  server.registerTool(
    'save',
    { title: 'Guardar contexto', description: 'Escribe el pack a un .md. Requiere confirm:true.', inputSchema: z.object({ path: z.string().min(2), output: z.string().optional(), confirm: z.boolean().optional() }) },
    async (args) => {
      if (READ_ONLY) throw new Error('modo read-only: save deshabilitado');
      if (args.confirm !== true) throw new Error('save requiere confirm:true y pedido explícito');
      const pack = buildPack(scanProject(args.path));
      const target = args.output ? path.resolve(args.output) : path.join(CACHE_DIR, `${path.basename(path.resolve(args.path))}-context.md`);
      if (!isAllowedOutput(target)) throw new Error(`ruta de salida no permitida: ${target}`);
      mkdirSync(path.dirname(target), { recursive: true });
      const file = uniquePath(target);
      writeFileSync(file, pack, 'utf8');
      return textResult(`Contexto guardado: ${file} (${pack.length} caracteres)`);
    },
  );

  return server;
}

try { if (!READ_ONLY) mkdirSync(CACHE_DIR, { recursive: true }); } catch { /* ignora */ }
log(`modo: ${READ_ONLY ? 'read-only' : 'normal'}`);
serveStdio(buildServer, { onerror: (e) => log(`serveStdio: ${e.message}`) });
process.on('uncaughtException', (e) => log(`excepción: ${e.message}`));
process.on('unhandledRejection', (e) => log(`rechazo: ${e && e.message ? e.message : String(e)}`));
