const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pty = require('node-pty');

// --- .env load ---
const envPath = path.join(__dirname, '.env');
try {
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  }
} catch (e) {}

const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true';
function debug(...args) { if (DEBUG) console.log(...args); }

// --- Project root (bound at launch, switchable at runtime) ---
let currentRoot = path.resolve(process.argv[2] || process.env.ROOT || process.cwd());
if (!fs.existsSync(currentRoot) || !fs.statSync(currentRoot).isDirectory()) {
  console.error(`Root path is not a directory: ${currentRoot}`);
  process.exit(1);
}

// --- Project config (per-root, stored in <root>/.hackerspace/config.json) ---
function hackspaceDir(root) { return path.join(root, '.hackerspace'); }
function configFile(root) { return path.join(hackspaceDir(root), 'config.json'); }
const crypto = require('crypto');
const sessionsDir = path.join(__dirname, 'sessions');
function sessionFile(root) {
  const hash = crypto.createHash('md5').update(path.resolve(root)).digest('hex').slice(0, 12);
  const name = path.basename(root).replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(sessionsDir, `${name}-${hash}.json`);
}

function loadProjectConfig(root) {
  try { return JSON.parse(fs.readFileSync(configFile(root), 'utf-8')); }
  catch (e) { return { agents: {} }; }
}
function saveProjectConfig(root, cfg) {
  try {
    const dir = hackspaceDir(root);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(configFile(root), JSON.stringify(cfg, null, 2), 'utf-8');
  } catch (e) { debug('[config] save failed:', e.message); }
}

// --- Session persistence (stored in <serverdir>/sessions/<name>-<hash>.json) ---
function loadSession(root) {
  try {
    const data = JSON.parse(fs.readFileSync(sessionFile(root), 'utf-8'));
    return {
      selectedTab: data.selectedTab || null,
      chatHistory: data.chatHistory || {},
      openFiles: data.openFiles || {},
      shellOpen: !!data.shellOpen,
      shellTabs: data.shellTabs || {},
      agentSettings: data.agentSettings || {},
      cmdDrafts: data.cmdDrafts || {},
      theme: data.theme || null,
      layout: data.layout || null,
      splitWidth: data.splitWidth || null,
      savedAt: data.savedAt || 0,
    };
  } catch (e) {
    return { selectedTab: null, chatHistory: {}, openFiles: {}, shellOpen: false, shellTabs: {}, agentSettings: {}, cmdDrafts: {}, theme: null, layout: null, splitWidth: null, savedAt: 0 };
  }
}

function saveSession(root, data) {
  try {
    if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(sessionFile(root), JSON.stringify(data), 'utf-8');
  } catch (e) { debug('[session] save failed:', e.message); }
}

function mergeAgentHistory(root) {
  const session = loadSession(root);
  for (const [id, agent] of agents) {
    const tab = tabById(id);
    if (!tab || agent.outputBuffer.length === 0) continue;
    session.chatHistory[tab.name] = agent.outputBuffer.slice(-300).map(l => ({
      text: l.text, cls: l.cls, ts: l.ts
    }));
  }
  saveSession(root, session);
}

// --- Projects registry (stored in <appdir>/projects.json) ---
const projectsJsonPath = path.join(__dirname, 'projects.json');

function loadProjectsRegistry() {
  try { return JSON.parse(fs.readFileSync(projectsJsonPath, 'utf-8')); }
  catch (e) { return { projects: [], active: null }; }
}

function saveProjectsRegistry(data) {
  try { fs.writeFileSync(projectsJsonPath, JSON.stringify(data, null, 2), 'utf-8'); }
  catch (e) { debug('[projects] save failed:', e.message); }
}

function updateActiveProject(projectPath) {
  const data = loadProjectsRegistry();
  data.active = path.resolve(projectPath);
  saveProjectsRegistry(data);
}

function getProjectName(projectPath) {
  const reg = loadProjectsRegistry();
  const resolved = path.resolve(projectPath);
  const entry = reg.projects.find(p => path.resolve(p.path) === resolved);
  return (entry && entry.name) || path.basename(projectPath);
}

// On startup: use active project from projects.json if available, else fall back to ROOT/cwd
{
  const reg = loadProjectsRegistry();
  if (reg.active && fs.existsSync(reg.active) && fs.statSync(reg.active).isDirectory()) {
    currentRoot = path.resolve(reg.active);
  }
  updateActiveProject(currentRoot);
}

// --- Tab discovery ---
const HIDDEN_NAMES = new Set([
  'node_modules', 'dist', 'build', '.next', 'out', 'target',
  'venv', '.venv', '__pycache__', '.pytest_cache', '.mypy_cache',
  '.turbo', '.cache', '.parcel-cache', 'coverage', '.nyc_output',
  'vendor', '.gradle', '.idea', '.vscode',
]);

function discoverTabs(root) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch (e) { return []; }
  return entries
    .filter(e => e.isDirectory() || e.isSymbolicLink())
    .map(e => ({
      name: e.name,
      path: path.join(root, e.name),
      hidden: e.name.startsWith('.') || HIDDEN_NAMES.has(e.name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// --- Agent state: keyed by numeric id (1..N), dynamic ---
const agents = new Map();
let tabs = [];
let nextId = 1;

function buildTabs() {
  const discovered = discoverTabs(currentRoot);
  const cfg = loadProjectConfig(currentRoot);
  const prev = tabs;
  tabs = discovered.map(d => {
    const existing = prev.find(t => t.name === d.name && t.path === d.path);
    const id = existing ? existing.id : nextId++;
    const agentCfg = (cfg.agents && cfg.agents[d.name]) || {};
    return {
      id, name: d.name, path: d.path, hidden: d.hidden,
      systemPrompt: agentCfg.systemPrompt || '',
    };
  });
  return tabs;
}

function tabById(id) { return tabs.find(t => t.id === id); }
function tabByName(name) { return tabs.find(t => t.name === name); }

// --- Express / WebSocket ---
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 50 * 1024 * 1024 });

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- Process control ---
function killProc(pid) {
  if (!pid) return;
  try { process.kill(pid, 'SIGTERM'); } catch (e) {}
}

function killPort(port) {
  if (!port) return;
  try {
    const proc = spawn('sh', ['-c', `lsof -ti tcp:${port} | xargs kill -9 2>/dev/null || true`], { stdio: 'ignore' });
    proc.on('error', () => {});
  } catch (e) {}
}

// --- HTTP: project state ---
function tabsPublic() {
  return tabs.map(t => ({ id: t.id, name: t.name, path: t.path, hidden: t.hidden, hasPrompt: !!t.systemPrompt }));
}

app.get('/projects', (req, res) => {
  buildTabs();
  res.json({ root: currentRoot, rootName: getProjectName(currentRoot), tabs: tabsPublic() });
});

app.post('/switch-root', (req, res) => {
  const { path: newRoot } = req.body || {};
  if (!newRoot || typeof newRoot !== 'string') return res.status(400).json({ ok: false, error: 'path required' });
  const resolved = path.resolve(newRoot);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return res.status(400).json({ ok: false, error: 'not a directory' });
  }
  mergeAgentHistory(currentRoot);
  for (const [, agent] of agents) if (agent.process) killProc(agent.process.pid);
  agents.clear();
  for (const [, ds] of devServers) if (ds.process) killProc(ds.process.pid);
  devServers.clear();
  tabs = [];
  nextId = 1;
  currentRoot = resolved;
  updateActiveProject(currentRoot);
  buildTabs();
  const payload = { root: currentRoot, rootName: getProjectName(currentRoot), tabs: tabsPublic() };
  broadcast({ type: 'root_changed', ...payload });
  res.json({ ok: true, ...payload });
});

// --- HTTP: projects registry ---
app.get('/projects-list', (req, res) => {
  const data = loadProjectsRegistry();
  const projects = data.projects.map(p => ({
    path: p.path,
    name: path.basename(p.path.replace(/\/+$/, '')),
    active: path.resolve(p.path) === path.resolve(currentRoot),
  }));
  res.json({ projects, active: currentRoot });
});

app.post('/projects/add', (req, res) => {
  const { path: newPath } = req.body || {};
  if (!newPath || typeof newPath !== 'string') return res.status(400).json({ ok: false, error: 'path required' });
  const resolved = path.resolve(newPath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return res.status(400).json({ ok: false, error: 'not a directory' });
  }
  const data = loadProjectsRegistry();
  if (!data.projects.find(p => path.resolve(p.path) === resolved)) {
    data.projects.push({ path: resolved });
    saveProjectsRegistry(data);
  }
  res.json({ ok: true });
});

app.post('/projects/remove', (req, res) => {
  const { path: rmPath } = req.body || {};
  if (!rmPath || typeof rmPath !== 'string') return res.status(400).json({ ok: false, error: 'path required' });
  const resolved = path.resolve(rmPath);
  if (resolved === path.resolve(currentRoot)) {
    return res.status(400).json({ ok: false, error: 'cannot remove active project' });
  }
  const data = loadProjectsRegistry();
  data.projects = data.projects.filter(p => path.resolve(p.path) !== resolved);
  saveProjectsRegistry(data);
  res.json({ ok: true });
});

// --- HTTP: file listing ---
app.get('/files', (req, res) => {
  const dir = req.query.dir;
  if (!dir || typeof dir !== 'string') return res.status(400).json({ error: 'dir required' });
  const resolved = path.resolve(dir);
  const rootResolved = path.resolve(currentRoot);
  if (!resolved.startsWith(rootResolved) && resolved !== rootResolved) {
    return res.status(403).json({ error: 'path outside project root' });
  }
  try {
    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    const result = entries
      .filter(e => e.name !== '.DS_Store')
      .map(e => {
        const isDir = e.isDirectory() || e.isSymbolicLink();
        const entry = { name: e.name, type: isDir ? 'directory' : 'file' };
        if (!isDir) {
          try { entry.size = fs.statSync(path.join(resolved, e.name)).size; } catch (_) {}
        }
        return entry;
      })
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    res.json({ dir: resolved, entries: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- HTTP: file read/write ---
const BINARY_EXTS = new Set([
  'png','jpg','jpeg','gif','bmp','ico','webp','avif','tiff','tif','svg',
  'mp3','mp4','wav','ogg','flac','aac','m4a','webm','avi','mov','mkv',
  'zip','gz','tar','bz2','xz','7z','rar','zst','br',
  'woff','woff2','ttf','otf','eot',
  'pdf','doc','docx','xls','xlsx','ppt','pptx',
  'exe','dll','so','dylib','bin','o','a','lib',
  'class','jar','pyc','pyo','wasm',
  'sqlite','db','sqlite3',
  'iso','dmg','img',
]);

function isTextFile(name) {
  const ext = name.split('.').pop().toLowerCase();
  return !BINARY_EXTS.has(ext);
}

app.get('/file-content', (req, res) => {
  const filePath = req.query.path;
  if (!filePath || typeof filePath !== 'string') return res.status(400).json({ error: 'path required' });
  const resolved = path.resolve(filePath);
  const rootResolved = path.resolve(currentRoot);
  if (!resolved.startsWith(rootResolved) && resolved !== rootResolved) {
    return res.status(403).json({ error: 'path outside project root' });
  }
  try {
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) return res.status(400).json({ error: 'is a directory' });
    if (stat.size > 1024 * 1024) return res.status(400).json({ error: 'file too large (>1MB)' });
    const name = path.basename(resolved);
    if (!isTextFile(name)) return res.status(400).json({ error: 'binary file' });
    const content = fs.readFileSync(resolved, 'utf-8');
    res.json({ path: resolved, name, content, size: stat.size });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/file-content', (req, res) => {
  const { path: filePath, content } = req.body || {};
  if (!filePath || typeof filePath !== 'string') return res.status(400).json({ ok: false, error: 'path required' });
  if (typeof content !== 'string') return res.status(400).json({ ok: false, error: 'content required' });
  const resolved = path.resolve(filePath);
  const rootResolved = path.resolve(currentRoot);
  if (!resolved.startsWith(rootResolved) && resolved !== rootResolved) {
    return res.status(403).json({ ok: false, error: 'path outside project root' });
  }
  try {
    fs.writeFileSync(resolved, content, 'utf-8');
    res.json({ ok: true, size: Buffer.byteLength(content, 'utf-8') });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- HTTP: system stats ---
let lastCpuInfo = os.cpus();
app.get('/system-stats', (req, res) => {
  const cpus = os.cpus();
  let totalIdle = 0, totalTick = 0;
  for (let i = 0; i < cpus.length; i++) {
    const cur = cpus[i].times;
    const prev = lastCpuInfo[i] ? lastCpuInfo[i].times : cur;
    const idle = cur.idle - prev.idle;
    const total = (cur.user - prev.user) + (cur.nice - prev.nice) + (cur.sys - prev.sys) + (cur.irq - prev.irq) + idle;
    totalIdle += idle;
    totalTick += total;
  }
  lastCpuInfo = cpus;
  const cpuPercent = totalTick > 0 ? Math.round((1 - totalIdle / totalTick) * 100) : 0;
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const ramPercent = Math.round((1 - freeMem / totalMem) * 100);
  const totalGB = (totalMem / 1024 / 1024 / 1024).toFixed(0);
  const usedGB = ((totalMem - freeMem) / 1024 / 1024 / 1024).toFixed(1);
  res.json({ cpu: cpuPercent, ram: ramPercent, ramUsed: usedGB, ramTotal: totalGB });
});

// --- HTTP: git status ---
app.get('/git-status', (req, res) => {
  const cwd = req.query.cwd;
  if (!cwd) return res.json({ git: false });
  const execGit = (args) => new Promise((resolve) => {
    const proc = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', d => out += d.toString());
    proc.on('close', (code) => resolve(code === 0 ? out.trim() : null));
    proc.on('error', () => resolve(null));
  });
  Promise.all([
    execGit(['rev-parse', '--is-inside-work-tree']),
    execGit(['rev-parse', '--show-toplevel']),
    execGit(['branch', '--show-current']),
    execGit(['status', '--porcelain']),
    execGit(['rev-list', '--count', '--left-right', '@{u}...HEAD']),
    execGit(['log', '-1', '--format=%s']),
  ]).then(([isGit, gitRoot, branch, porcelain, leftRight, lastMsg]) => {
    if (isGit !== 'true') return res.json({ git: false });
    if (gitRoot && path.resolve(cwd) !== path.resolve(gitRoot)) return res.json({ git: false });
    const dirty = porcelain ? porcelain.split('\n').filter(l => l.trim()).length : 0;
    let ahead = 0, behind = 0;
    if (leftRight) {
      const parts = leftRight.split('\t');
      behind = parseInt(parts[0]) || 0;
      ahead = parseInt(parts[1]) || 0;
    }
    res.json({ git: true, branch: branch || 'detached', dirty, ahead, behind, lastCommit: lastMsg || '' });
  }).catch(() => res.json({ git: false }));
});

// --- HTTP: folder picker (macOS osascript) ---
app.get('/pick-folder', (req, res) => {
  const startDir = req.query.start || os.homedir();
  const script = `
    try
      set chosenFolder to choose folder with prompt "Select project root" default location (POSIX file "${startDir.replace(/"/g, '\\"')}")
      return POSIX path of chosenFolder
    on error number -128
      return ""
    end try
  `;
  const proc = spawn('osascript', ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', d => out += d.toString());
  proc.on('close', () => {
    const folder = out.trim().replace(/\/$/, '');
    res.json({ folder: folder || null });
  });
  proc.on('error', () => res.json({ folder: null }));
});

// --- HTTP: auth ---
let _authCache = null;
let _authCacheTime = 0;

function getGitEmail(cb) {
  const proc = spawn('git', ['config', 'user.email'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', d => out += d.toString());
  proc.on('close', () => cb(out.trim() || null));
  proc.on('error', () => cb(null));
}

app.get('/auth-status', (req, res) => {
  if (_authCache && Date.now() - _authCacheTime < 30000) return res.json(_authCache);
  const proc = spawn('claude', ['auth', 'status'], { stdio: ['ignore', 'pipe', 'pipe'], shell: true });
  let out = '';
  proc.stdout.on('data', d => out += d.toString());
  proc.on('close', (code) => {
    getGitEmail((gitEmail) => {
      if (code === 0) {
        try {
          _authCache = JSON.parse(out.trim());
          if (gitEmail) _authCache.gitEmail = gitEmail;
          _authCacheTime = Date.now();
          return res.json(_authCache);
        } catch (e) {}
      }
      const apiKey = process.env.ANTHROPIC_API_KEY;
      const fallback = {
        loggedIn: !!apiKey,
        authMethod: apiKey ? 'api_key' : 'none',
        apiKey: apiKey ? apiKey.slice(0, 10) + '...' + apiKey.slice(-4) : null,
      };
      if (gitEmail) fallback.gitEmail = gitEmail;
      _authCache = fallback;
      _authCacheTime = Date.now();
      res.json(fallback);
    });
  });
  proc.on('error', () => res.json({ loggedIn: false, authMethod: 'none' }));
});

app.post('/auth-login', (req, res) => {
  const proc = spawn('claude', ['auth', 'login'], { stdio: ['ignore', 'pipe', 'pipe'], shell: true });
  let out = '', err = '';
  proc.stdout.on('data', d => out += d.toString());
  proc.stderr.on('data', d => err += d.toString());
  proc.on('close', (code) => {
    _authCache = null;
    if (code === 0) res.json({ ok: true });
    else res.json({ ok: false, error: err.trim() || 'Login failed' });
  });
  proc.on('error', (e) => res.json({ ok: false, error: e.message }));
});

app.post('/auth-apikey', (req, res) => {
  const key = req.body && req.body.key;
  if (!key || typeof key !== 'string' || !key.startsWith('sk-ant-')) {
    return res.json({ ok: false, error: 'Invalid API key format (must start with sk-ant-)' });
  }
  process.env.ANTHROPIC_API_KEY = key;
  try {
    let envContent = '';
    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, 'utf-8');
      if (/^ANTHROPIC_API_KEY=.*/m.test(envContent)) {
        envContent = envContent.replace(/^ANTHROPIC_API_KEY=.*/m, `ANTHROPIC_API_KEY=${key}`);
      } else {
        envContent += `\nANTHROPIC_API_KEY=${key}`;
      }
    } else {
      envContent = `ANTHROPIC_API_KEY=${key}`;
    }
    fs.writeFileSync(envPath, envContent.trim() + '\n', 'utf-8');
  } catch (e) {}
  _authCache = null;
  res.json({ ok: true });
});

// --- HTTP: per-agent system prompt ---
app.get('/agent-prompt', (req, res) => {
  const tab = tabByName(req.query.name);
  if (!tab) return res.status(404).json({ ok: false, error: 'tab not found' });
  res.json({ ok: true, name: tab.name, systemPrompt: tab.systemPrompt || '' });
});

app.post('/agent-prompt', (req, res) => {
  const { name, systemPrompt } = req.body || {};
  if (!name || typeof name !== 'string') return res.status(400).json({ ok: false, error: 'name required' });
  const tab = tabByName(name);
  if (!tab) return res.status(404).json({ ok: false, error: 'tab not found' });
  const trimmed = typeof systemPrompt === 'string' ? systemPrompt.trim() : '';
  tab.systemPrompt = trimmed;
  const cfg = loadProjectConfig(currentRoot);
  cfg.agents = cfg.agents || {};
  cfg.agents[name] = cfg.agents[name] || {};
  cfg.agents[name].systemPrompt = trimmed;
  saveProjectConfig(currentRoot, cfg);
  broadcast({ type: 'agent_prompt_updated', id: tab.id, name, hasPrompt: !!trimmed });
  res.json({ ok: true });
});

// --- HTTP: session persistence ---
app.get('/session', (req, res) => {
  const session = loadSession(currentRoot);
  res.json(session);
});

app.post('/session', (req, res) => {
  const data = req.body;
  if (!data || typeof data !== 'object') return res.status(400).json({ ok: false, error: 'invalid body' });
  const session = {
    selectedTab: data.selectedTab || null,
    chatHistory: data.chatHistory || {},
    openFiles: data.openFiles || {},
    shellOpen: !!data.shellOpen,
    shellTabs: data.shellTabs || {},
    agentSettings: data.agentSettings || {},
    cmdDrafts: data.cmdDrafts || {},
    theme: data.theme || null,
    layout: data.layout || null,
    splitWidth: data.splitWidth || null,
    savedAt: Date.now(),
  };
  saveSession(currentRoot, session);
  res.json({ ok: true });
});

// --- Agent lifecycle ---
function broadcast(msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach(client => { if (client.readyState === 1) client.send(data); });
}

function getAgentInfo(id) {
  const tab = tabById(id);
  const agent = agents.get(id);
  if (!agent) return { id, status: 'sleeping', name: tab ? tab.name : `agent-${id}` };
  return { id, status: agent.status, name: tab ? tab.name : `agent-${id}`, awakeAt: agent.awakeAt, lastOutputTime: agent.lastOutputTime };
}

function setStatus(id, status) {
  const agent = agents.get(id);
  if (agent) agent.status = status;
  const tab = tabById(id);
  broadcast({ type: 'agent_status', id, status, name: tab ? tab.name : null });
}

function bufferPush(agent, entry) {
  agent.outputBuffer.push(entry);
  if (agent.outputBuffer.length > 500) agent.outputBuffer = agent.outputBuffer.slice(-400);
}

const _summoning = new Set();

function summonAgent(id) {
  const tab = tabById(id);
  if (!tab) return;
  if (_summoning.has(id)) return;
  if (agents.has(id) && agents.get(id).status !== 'sleeping') {
    broadcast({ type: 'agent_error', id, error: 'Agent already awake' });
    return;
  }
  _summoning.add(id);
  agents.set(id, {
    id, process: null, status: 'awake', outputBuffer: [], currentDelta: '',
    sessionId: null, lastOutputTime: 0, lastTextOutput: null,
    awakeAt: Date.now(), cwd: tab.path,
  });
  broadcast({ type: 'agent_spawned', id, name: tab.name, cwd: tab.path });
  setStatus(id, 'awake');
  _summoning.delete(id);
}

function sendCommand(id, text, model, mode, images, label) {
  const tab = tabById(id);
  if (!tab) { broadcast({ type: 'agent_error', id, error: 'Unknown agent id' }); return; }
  if (!agents.has(id) || agents.get(id).status === 'sleeping') summonAgent(id);
  const agent = agents.get(id);
  if (!agent) { broadcast({ type: 'agent_error', id, error: 'Failed to summon agent.' }); return; }

  if (label) bufferPush(agent, { text: label, cls: 'term-cmd', ts: Date.now() });

  const workDir = agent.cwd || tab.path;
  const args = ['-p', '--verbose', '--output-format', 'stream-json', '--input-format', 'stream-json'];

  if (tab.systemPrompt) args.push('--append-system-prompt', tab.systemPrompt);
  if (model) args.push('--model', model);

  const effectiveMode = agent._tempBypass ? 'bypass' : mode;
  if (effectiveMode === 'bypass') args.push('--dangerously-skip-permissions');
  else if (effectiveMode === 'plan') args.push('--permission-mode', 'plan');

  if (agent._allowedTools && agent._allowedTools.size > 0 && effectiveMode !== 'bypass') {
    args.push('--allowed-tools', ...agent._allowedTools);
  }
  if (agent._tempBypass) agent._tempBypass = false;
  if (agent.sessionId) args.push('--resume', agent.sessionId);

  if (agent.process) { killProc(agent.process.pid); agent.process = null; }

  agent._generation = (agent._generation || 0) + 1;
  const gen = agent._generation;
  setStatus(id, 'working');

  debug(`[${tab.name}] claude ${args.join(' ')} (cwd: ${workDir})`);

  const proc = spawn('claude', args, {
    cwd: workDir, shell: true, env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const content = [{ type: 'text', text }];
  if (images && images.length > 0) {
    for (const img of images) {
      content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
    }
  }
  proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');

  agent.process = proc;
  agent._lastCmd = { text, model, mode };
  agent.lastOutputTime = Date.now();
  agent.lineBuf = '';

  proc.stdout.on('data', (data) => {
    if (agent._generation !== gen) return;
    agent.lastOutputTime = Date.now();
    agent.lineBuf += data.toString();
    if (agent.lineBuf.length > 1024 * 1024) { agent.lineBuf = ''; return; }
    const parts = agent.lineBuf.split('\n');
    agent.lineBuf = parts.pop();
    for (const line of parts) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed;
      try { parsed = JSON.parse(trimmed); } catch (e) { continue; }

      if (parsed.session_id) agent.sessionId = parsed.session_id;

      if (parsed.type === 'system') {
        if (parsed.cwd) {
          agent.cwd = parsed.cwd;
          broadcast({ type: 'agent_cwd', id, cwd: parsed.cwd });
        }
        if (parsed.permissionMode) {
          const modeLabel = { default: 'Normal', plan: 'Plan', bypassPermissions: 'Bypass' }[parsed.permissionMode] || parsed.permissionMode;
          const pmText = `[Permission mode: ${modeLabel}]`;
          bufferPush(agent, { text: pmText, cls: 'term-system', ts: Date.now() });
          broadcast({ type: 'agent_output', id, text: pmText, done: false, format: 'system' });
        }
      }

      if (parsed.type === 'assistant' && parsed.message) {
        const blocks = parsed.message.content || [];
        for (const block of blocks) {
          if (block.type === 'text') {
            const formatted = `${tab.name}> ${block.text}`;
            bufferPush(agent, { text: formatted, cls: 'term-text', ts: Date.now() });
            agent.lastTextOutput = block.text.trim();
            broadcast({ type: 'agent_output', id, text: formatted, done: false, format: 'text' });
          } else if (block.type === 'tool_use') {
            const toolName = block.name || 'unknown';
            let toolInfo = `${tab.name} [tool]> ${toolName}`;
            if (block.input) {
              if (block.input.file_path) toolInfo += ` → ${block.input.file_path}`;
              if (block.input.content && (toolName === 'Write' || toolName === 'TodoWrite')) {
                toolInfo += `\n${block.input.content}`;
              }
            }
            bufferPush(agent, { text: toolInfo, cls: 'term-tool', ts: Date.now() });
            broadcast({ type: 'agent_output', id, text: toolInfo, done: false, format: 'tool' });
          }
        }
      } else if (parsed.type === 'content_block_delta') {
        if (parsed.delta && parsed.delta.text) {
          agent.currentDelta += parsed.delta.text;
          broadcast({ type: 'agent_output', id, text: parsed.delta.text, done: false, format: 'delta' });
        }
      } else if (parsed.type === 'result') {
        if (parsed.session_id) agent.sessionId = parsed.session_id;
        if (agent.currentDelta) {
          bufferPush(agent, { text: `${tab.name}> ${agent.currentDelta}`, cls: 'term-text', ts: Date.now() });
          agent.lastTextOutput = agent.currentDelta.trim();
          agent.currentDelta = '';
        }
        if (parsed.permission_denials && parsed.permission_denials.length > 0) {
          broadcast({
            type: 'agent_permission_denied',
            id,
            denials: parsed.permission_denials.map(d => ({ tool_name: d.tool_name, tool_input: d.tool_input })),
          });
        }
        const usage = parsed.usage || parsed.token_usage || null;
        const modelOut = parsed.model || null;
        if (usage) agent.lastUsage = usage;
        if (modelOut) agent.lastModel = modelOut;
        if (usage || modelOut) broadcast({ type: 'agent_meta', id, usage, model: modelOut, session_id: parsed.session_id });
        broadcast({ type: 'agent_output', id, text: '', done: true });
        if (agents.has(id) && agents.get(id).status === 'working') setStatus(id, 'awake');
      } else if (parsed.type === 'rate_limit_event' && parsed.rate_limit_info) {
        broadcast({
          type: 'rate_limit', id,
          resetsAt: parsed.rate_limit_info.resetsAt,
          status: parsed.rate_limit_info.status,
          rateLimitType: parsed.rate_limit_info.rateLimitType,
        });
      }
    }
  });

  proc.stderr.on('data', (data) => {
    if (agent._generation !== gen) return;
    const text = data.toString().trim();
    if (!text) return;
    if (/hook.*(cancelled|failed|started|completed)/i.test(text) || /Session(End|Start).*hook/i.test(text)) return;
    broadcast({ type: 'agent_output', id, text: `${tab.name} [stderr]> ${text}`, done: false, format: 'error' });
  });

  proc.on('close', (code) => {
    if (agent._generation !== gen) return;
    if (agent.currentDelta) {
      bufferPush(agent, { text: `${tab.name}> ${agent.currentDelta}`, cls: 'term-text', ts: Date.now() });
      agent.currentDelta = '';
    }
    agent.process = null;
    if (code !== 0 && code !== null) {
      const msg = code === 1 ? 'Cancelled by the user' : `Process error (code ${code})`;
      broadcast({ type: 'agent_output', id, text: `${tab.name}> ${msg}`, done: false, format: 'error' });
    }
    broadcast({ type: 'agent_output', id, text: '', done: true });
    if (agents.has(id) && agents.get(id).status !== 'sleeping') setStatus(id, 'awake');
  });

  proc.on('error', (err) => {
    if (agent._generation !== gen) return;
    agent.process = null;
    broadcast({ type: 'agent_error', id, error: err.message });
    if (agents.has(id)) setStatus(id, 'awake');
  });
}

function sleepAgent(id) {
  const agent = agents.get(id);
  if (!agent) return;
  const cwd = agent.cwd;
  if (cwd) stopDevServer(cwd);
  if (agent.process) { killProc(agent.process.pid); agent.process = null; }
  agent.status = 'sleeping';
  agent.sessionId = null;
  agent.outputBuffer = [];
  agent.currentDelta = '';
  agent.lastTextOutput = null;
  broadcast({ type: 'agent_killed', id });
  setStatus(id, 'sleeping');
  agents.delete(id);
}

// --- WebSocket ---
wss.on('connection', (ws) => {
  buildTabs();
  const session = loadSession(currentRoot);
  ws.send(JSON.stringify({
    type: 'root_changed',
    root: currentRoot,
    rootName: getProjectName(currentRoot),
    tabs: tabsPublic(),
    session,
  }));
  for (const tab of tabs) {
    const info = getAgentInfo(tab.id);
    ws.send(JSON.stringify({ type: 'agent_status', ...info }));
    const agent = agents.get(tab.id);
    if (agent && agent.cwd) ws.send(JSON.stringify({ type: 'agent_cwd', id: tab.id, cwd: agent.cwd }));
    if (agent && agent.outputBuffer.length > 0) {
      ws.send(JSON.stringify({ type: 'agent_history', id: tab.id, lines: agent.outputBuffer }));
    } else if (session.chatHistory && session.chatHistory[tab.name] && session.chatHistory[tab.name].length > 0) {
      ws.send(JSON.stringify({ type: 'agent_history', id: tab.id, lines: session.chatHistory[tab.name] }));
    }
    if (agent && (agent.lastUsage || agent.lastModel)) {
      ws.send(JSON.stringify({
        type: 'agent_meta', id: tab.id,
        usage: agent.lastUsage || null, model: agent.lastModel || null,
        session_id: agent.sessionId || null,
      }));
    }
  }

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    switch (msg.type) {
      case 'summon': summonAgent(msg.id); break;
      case 'command': sendCommand(msg.id, msg.text, msg.model, msg.mode, msg.images, msg.label); break;
      case 'user_cmd': {
        const a = agents.get(msg.id);
        if (a) bufferPush(a, { text: msg.text, cls: msg.cls || 'term-cmd', ts: Date.now() });
        break;
      }
      case 'clear': {
        const a = agents.get(msg.id);
        if (a) {
          a.sessionId = null;
          a.outputBuffer = [];
          a.currentDelta = '';
          a.lastTextOutput = null;
        }
        const clearTab = tabById(msg.id);
        if (clearTab) {
          const s = loadSession(currentRoot);
          delete s.chatHistory[clearTab.name];
          saveSession(currentRoot, s);
        }
        break;
      }
      case 'save_session': {
        if (msg.data && typeof msg.data === 'object') {
          const existing = loadSession(currentRoot);
          existing.selectedTab = msg.data.selectedTab ?? existing.selectedTab;
          existing.openFiles = msg.data.openFiles ?? existing.openFiles;
          existing.shellOpen = msg.data.shellOpen ?? existing.shellOpen;
          existing.shellTabs = msg.data.shellTabs ?? existing.shellTabs;
          existing.agentSettings = msg.data.agentSettings ?? existing.agentSettings;
          existing.cmdDrafts = msg.data.cmdDrafts ?? existing.cmdDrafts;
          existing.theme = msg.data.theme ?? existing.theme;
          existing.layout = msg.data.layout ?? existing.layout;
          existing.splitWidth = msg.data.splitWidth ?? existing.splitWidth;
          if (msg.data.chatHistory) {
            for (const [name, lines] of Object.entries(msg.data.chatHistory)) {
              existing.chatHistory[name] = lines;
            }
          }
          existing.savedAt = Date.now();
          saveSession(currentRoot, existing);
        }
        break;
      }
      case 'stop': {
        const a = agents.get(msg.id);
        if (a && a.process) {
          killProc(a.process.pid);
          a.process = null;
          broadcast({ type: 'agent_output', id: msg.id, text: '', done: true });
          setStatus(msg.id, 'awake');
        }
        break;
      }
      case 'sleep': sleepAgent(msg.id); break;
      case 'permission_allow': {
        const a = agents.get(msg.id);
        if (a && msg.tool_name) {
          if (!a._allowedTools) a._allowedTools = new Set();
          a._allowedTools.add(msg.tool_name);
          if (a.process) { killProc(a.process.pid); a.process = null; }
          const lastCmd = a._lastCmd;
          if (lastCmd && a.sessionId) {
            sendCommand(msg.id, `The ${msg.tool_name} tool has been approved. Please retry your previous action.`, lastCmd.model, lastCmd.mode, null, null);
          }
        }
        break;
      }
      case 'permission_allow_all': {
        const a = agents.get(msg.id);
        if (a) {
          a._tempBypass = true;
          if (a.process) { killProc(a.process.pid); a.process = null; }
          const lastCmd = a._lastCmd;
          if (lastCmd && a.sessionId) {
            sendCommand(msg.id, 'All tool permissions have been granted. Please retry your previous action.', lastCmd.model, lastCmd.mode, null, null);
          }
        }
        break;
      }
      case 'dev_server': {
        const cwd = msg.cwd;
        if (!cwd) break;
        if (msg.action === 'start') startDevServer(cwd);
        else if (msg.action === 'stop') stopDevServer(cwd);
        else if (msg.action === 'restart') restartDevServer(cwd);
        else if (msg.action === 'status') broadcastDevServer(cwd);
        break;
      }
      case 'pty_spawn': {
        const tabId = msg.tabId;
        if (tabId == null) break;
        const tab = tabById(tabId);
        const cwd = msg.cwd || (tab && tab.path) || currentRoot;
        spawnPty(ws, tabId, cwd, msg.cols || 80, msg.rows || 24);
        break;
      }
      case 'pty_input': {
        const p = ptyProcesses.get(msg.tabId);
        if (p) p.pty.write(msg.data);
        break;
      }
      case 'pty_resize': {
        const p = ptyProcesses.get(msg.tabId);
        if (p && msg.cols && msg.rows) {
          try { p.pty.resize(msg.cols, msg.rows); } catch (_) {}
        }
        break;
      }
      case 'pty_kill': {
        killPty(msg.tabId);
        break;
      }
      default: debug('unknown msg type:', msg.type);
    }
  });
});

// --- PTY terminal ---
const ptyProcesses = new Map();

function spawnPty(ws, tabId, cwd, cols, rows) {
  const existing = ptyProcesses.get(tabId);
  if (existing) {
    existing.ws = ws;
    existing.send = (data) => {
      try { if (ws.readyState === 1) ws.send(JSON.stringify(data)); } catch (_) {}
    };
    try { existing.pty.resize(cols || 80, rows || 24); } catch (_) {}
    return;
  }
  const fishPaths = ['/opt/homebrew/bin/fish', '/usr/local/bin/fish', '/usr/bin/fish'];
  const fishPath = fishPaths.find(p => fs.existsSync(p));
  const shell = fishPath || process.env.SHELL || '/bin/zsh';
  const resolvedCwd = cwd && fs.existsSync(cwd) ? cwd : currentRoot;
  let p;
  try {
    p = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: cols || 80, rows: rows || 24,
      cwd: resolvedCwd,
      env: { ...process.env, TERM: 'xterm-256color' },
    });
  } catch (err) {
    debug('PTY spawn failed:', err.message);
    try { ws.send(JSON.stringify({ type: 'pty_exit', tabId, code: 1 })); } catch (_) {}
    return;
  }
  const entry = { pty: p, ws, send: null };
  entry.send = (data) => {
    try { if (entry.ws.readyState === 1) entry.ws.send(JSON.stringify(data)); } catch (_) {}
  };
  ptyProcesses.set(tabId, entry);

  p.onData((data) => entry.send({ type: 'pty_output', tabId, data }));
  p.onExit(({ exitCode }) => {
    ptyProcesses.delete(tabId);
    entry.send({ type: 'pty_exit', tabId, code: exitCode });
  });
}

function killPty(tabId) {
  const entry = ptyProcesses.get(tabId);
  if (!entry) return;
  try { entry.pty.kill(); } catch (_) {}
  ptyProcesses.delete(tabId);
}

// --- Dev server manager ---
const devServers = new Map();
function devServerKey(cwd) { return path.resolve(cwd); }

function broadcastDevServer(cwd) {
  const key = devServerKey(cwd);
  const ds = devServers.get(key);
  const info = ds ? { status: ds.status, port: ds.port, cwd: ds.cwd } : { status: 'off', port: null, cwd };
  broadcast({ type: 'dev_server_status', ...info });
}

function startDevServer(cwd) {
  const key = devServerKey(cwd);
  const existing = devServers.get(key);
  if (existing && existing.status === 'on') return;
  if (existing && existing.process) killProc(existing.process.pid);

  const ds = { process: null, status: 'starting', port: null, cwd };
  devServers.set(key, ds);
  broadcastDevServer(cwd);

  const proc = spawn('npm', ['run', 'dev'], { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  ds.process = proc;

  let outputBuf = '';
  let portFound = false;
  function parsePort(text) {
    if (portFound) return;
    const clean = text.replace(/\x1b\[[0-9;]*m/g, '');
    const m = clean.match(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{3,5})/i) || clean.match(/port\s+(\d{3,5})/i);
    if (m) {
      ds.port = parseInt(m[1]);
      ds.status = 'on';
      portFound = true;
      outputBuf = '';
      broadcastDevServer(cwd);
    }
  }
  proc.stdout.on('data', d => { if (!portFound && outputBuf.length < 10240) { outputBuf += d.toString(); parsePort(outputBuf); } });
  proc.stderr.on('data', d => { if (!portFound && outputBuf.length < 10240) { outputBuf += d.toString(); parsePort(outputBuf); } });
  proc.on('close', () => { ds.process = null; ds.status = 'off'; ds.port = null; broadcastDevServer(cwd); });
  proc.on('error', () => { ds.process = null; ds.status = 'off'; broadcastDevServer(cwd); });
  setTimeout(() => { if (ds.status === 'starting') { ds.status = 'on'; broadcastDevServer(cwd); } }, 10000);
}

function stopDevServer(cwd) {
  const key = devServerKey(cwd);
  const ds = devServers.get(key);
  if (!ds || !ds.process) {
    if (ds) { ds.status = 'off'; ds.port = null; }
    broadcastDevServer(cwd);
    return;
  }
  killProc(ds.process.pid);
  killPort(ds.port);
  ds.process = null;
  ds.status = 'off';
  ds.port = null;
  broadcastDevServer(cwd);
}

function restartDevServer(cwd) {
  const key = devServerKey(cwd);
  const ds = devServers.get(key);
  if (ds && ds.process) {
    ds.status = 'restarting';
    broadcastDevServer(cwd);
    const proc = ds.process;
    proc.on('close', () => startDevServer(cwd));
    killProc(proc.pid);
  } else {
    startDevServer(cwd);
  }
}

app.get('/dev-server-status', (req, res) => {
  const cwd = req.query.cwd;
  if (!cwd) return res.json({ status: 'off', port: null });
  const key = devServerKey(cwd);
  const ds = devServers.get(key);
  if (!ds) return res.json({ status: 'off', port: null, cwd });
  res.json({ status: ds.status, port: ds.port, cwd: ds.cwd });
});

// --- Start ---
buildTabs();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
server.listen(PORT, HOST, () => {
  console.log(`\n  hackerspace  —  ${path.basename(currentRoot)}  —  http://localhost:${PORT}\n  root: ${currentRoot}\n  tabs: ${tabs.filter(t => !t.hidden).length} visible, ${tabs.filter(t => t.hidden).length} hidden\n`);
});

setInterval(() => mergeAgentHistory(currentRoot), 30000);

function shutdown() {
  mergeAgentHistory(currentRoot);
  for (const [, agent] of agents) if (agent.process) killProc(agent.process.pid);
  for (const [, ds] of devServers) if (ds.process) killProc(ds.process.pid);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
