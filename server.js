/**
 * Monote — 本地服务器
 * 纯 Node.js 内置模块，零依赖。
 *
 * 打包为 exe（用于无 Node 环境的用户）：
 *   npm install -g pkg
 *   npm run build:exe
 *
 * 运行生成的 Monote.exe 即可启动服务器，
 * 终端会输出访问地址，浏览器打开即可使用。
 * 双击 Monote.exe 时会自动打开浏览器。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';

// ── Configuration persistence ──
// 可写目录：dev 模式用项目根目录，exe 模式用 exe 所在目录
const CONFIG_DIR = process.pkg
  ? path.dirname(process.execPath)
  : __dirname;
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

const DEFAULT_CONFIG = {
  theme: 'dark',
  lang: 'zh',
  layout: 'editor'
};

/** 从磁盘读取原始配置对象，失败返回 null */
function readConfigRaw() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    }
  } catch (_) {}
  return null;
}

/** 写入完整配置对象到磁盘 */
function writeConfigRaw(data) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (_) { return false; }
}

/** 读取配置（不存在则自动创建默认配置） */
function loadConfig() {
  const raw = readConfigRaw();
  if (raw) return { ...DEFAULT_CONFIG, ...raw };
  writeConfigRaw(DEFAULT_CONFIG);
  return { ...DEFAULT_CONFIG };
}

/** 合并保存部分配置字段 */
function saveConfig(partial) {
  const raw = readConfigRaw() || {};
  const merged = { ...raw, ...partial };
  return writeConfigRaw(merged);
}

/** API 辅助：解析请求体 JSON */
function parseJSONBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch (_) { resolve(null); }
    });
  });
}

// ── MIME types ──
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.txt':  'text/plain; charset=utf-8',
};

// ── Try to read a file; return null on failure ──
function readFileSafe(p) {
  try {
    return fs.readFileSync(p);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[Monote] read error:', err.message);
    }
    return null;
  }
}

// ── Check if a full path stays within a base directory ──
function isInside(base, fp) {
  const rel = path.relative(base, fp);
  return !rel.startsWith('..');
}

// ── Inline 404 fallback HTML (used when pages/404.html cannot be read) ──
const INLINE_404_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>404 — Monote</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:"DengXian","Microsoft YaHei",sans-serif;background:#f8f6f0;color:#2c2c2c;
  display:flex;flex-direction:column;height:100vh;overflow:hidden}
header{flex-shrink:0;border-bottom:1px solid #d0cec6;padding:0 28px;height:52px;
  display:flex;align-items:center;justify-content:space-between}
.logo{font-size:16px;letter-spacing:1.5px;font-weight:300;color:#6b6b6b}
.error-wrap{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 24px;text-align:center}
.code{font-size:96px;font-weight:100;letter-spacing:8px;color:#2c2c2c;opacity:.15;line-height:1;margin-bottom:12px}
.title{font-size:24px;font-weight:400;letter-spacing:2px;margin-bottom:10px}
.desc{font-size:15px;color:#6b6b6b;max-width:480px;margin-bottom:20px}
.actions{display:flex;gap:12px;flex-wrap:wrap;justify-content:center}
.btn{display:inline-flex;align-items:center;gap:6px;border:1px solid #d0cec6;height:38px;padding:0 22px;
  font-size:13px;color:#2c2c2c;text-decoration:none;cursor:pointer;letter-spacing:.5px;background:none}
.btn:hover{background:#f3f1eb;border-color:#2c2c2c}
.btn-primary{background:#2c2c2c;color:#f8f6f0;border-color:#2c2c2c}
.btn-primary:hover{background:#555;border-color:#555}
</style>
</head>
<body>
<header><div class="logo">Monote</div></header>
<div class="error-wrap">
  <div class="code">404</div>
  <div class="title">页面未找到</div>
  <div class="desc">您访问的路径在 Monote 上不存在，可能已被移动或删除。</div>
  <div class="actions">
    <a class="btn btn-primary" href="/">&#8592; 返回首页</a>
  </div>
</div>
</body>
</html>`;

// ── Serve the 404 page (from file or inline fallback) ──
function serve404(res, bases, requestedPath) {
  // Try to load the external 404.html page (try pages/ first, then base root for resources/)
  for (const base of bases) {
    // Try base/pages/404.html (dev mode)
    const p1 = path.join(base, 'pages', '404.html');
    if (isInside(base, p1)) {
      const data = readFileSafe(p1);
      if (data) {
        const enc = encodeURIComponent(requestedPath || '/');
        res.writeHead(302, { 'Location': '/404.html?path=' + enc });
        res.end();
        return;
      }
    }
    // Try base/404.html (packaged mode with resources/)
    const p2 = path.join(base, '404.html');
    if (isInside(base, p2)) {
      const data = readFileSafe(p2);
      if (data) {
        const enc = encodeURIComponent(requestedPath || '/');
        res.writeHead(302, { 'Location': '/404.html?path=' + enc });
        res.end();
        return;
      }
    }
  }
  // Fallback: serve inline HTML
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(INLINE_404_HTML);
}

// ── Serve a file (no redirect, used for serving 404.html directly) ──
function serveDirectFile(res, filePath, safe) {
  const data = readFileSafe(filePath);
  if (data) {
    const ext = path.extname(safe).toLowerCase();
    const contentType = MIME[ext] || 'application/octet-stream';
    const isText = contentType.startsWith('text/') || contentType.includes('javascript') || contentType.includes('json');
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(isText ? data.toString('utf-8') : data);
    return true;
  }
  return false;
}

// ── HTTP handler ──
const server = http.createServer(async (req, res) => {
  let urlPath = req.url.split('?')[0];

  // ── API: GET /api/config ──
  if (req.method === 'GET' && urlPath === '/api/config') {
    const cfg = loadConfig();
    const body = JSON.stringify(cfg);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(body);
    return;
  }

  // ── API: POST /api/config ──
  if (req.method === 'POST' && urlPath === '/api/config') {
    const data = await parseJSONBody(req);
    if (!data) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }
    saveConfig(data);
    const cfg = loadConfig();
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(cfg));
    return;
  }

  // Route: / -> main.html
  if (urlPath === '/') urlPath = '/main.html';

  // Prevent directory traversal
  const safe = path.normalize(urlPath).replace(/^(\.\.(\/|\\))+/g, '').replace(/^[/\\]+/, '');

  // Collect base directories to search
  const bases = [__dirname];
  if (process.pkg) {
    // 打包模式下优先从 exe 同级的 resources/ 加载页面
    const exeDir = path.dirname(process.execPath);
    const resDir = path.join(exeDir, 'resources');
    bases.unshift(resDir);
    bases.push(exeDir);
  }

  // Special handling: /404.html with path param — serve from pages/ or resources/
  if (safe === '404.html') {
    for (const base of bases) {
      // Try base/pages/404.html (dev mode)
      const fp1 = path.join(base, 'pages', '404.html');
      if (isInside(base, fp1) && serveDirectFile(res, fp1, safe)) {
        return;
      }
      // Try base/404.html (packaged mode with resources/)
      const fp2 = path.join(base, '404.html');
      if (isInside(base, fp2) && serveDirectFile(res, fp2, safe)) {
        return;
      }
    }
    // Fallback: inline 404 page
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(INLINE_404_HTML);
    return;
  }

  // Try pages/ first (dev mode), then root (resources/ mode)
  let data = null;
  for (const base of bases) {
    const inPages = path.join(base, 'pages', safe);
    if (isInside(base, inPages)) {
      data = readFileSafe(inPages);
      if (data) break;
    }
    const inRoot = path.join(base, safe);
    if (isInside(base, inRoot)) {
      data = readFileSafe(inRoot);
      if (data) break;
    }
  }

  if (!data) {
    serve404(res, bases, req.url);
    return;
  }

  const ext = path.extname(safe).toLowerCase();
  const contentType = MIME[ext] || 'application/octet-stream';
  const isText = contentType.startsWith('text/') || contentType.includes('javascript') || contentType.includes('json');

  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-cache, no-store, must-revalidate',
  });
  res.end(isText ? data.toString('utf-8') : data);
});

// ── Start server ──
server.on('error', (err) => {
  console.error('');
  console.error(' ╔ Monote ════════════════════════════');
  console.error(' ║ 服务器启动失败');
  console.error(' ║');
  console.error(' ║ 错误: ' + err.message);
  if (err.code === 'EADDRINUSE') {
    const altPort = PORT + 1;
    console.error(' ║');
    console.error(' ║ 端口 ' + PORT + ' 已被占用，可尝试：');
    console.error(' ║   set PORT=' + altPort + ' && Monote.exe');
  }
  console.error(' ╚════════════════════════════════════');
  console.error('');
  // 保持窗口打开，等待用户按键退出
  if (process.stdin && process.stdin.isTTY) {
    console.log('按任意键退出...');
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.once('data', () => { process.exit(1); });
  }
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;

  console.log('');
  console.log(' ╌ Monote ╌');
  console.log('');
  console.log('   服务器已启动');
  console.log(`   ${url}`);
  console.log('');
  console.log('   按 Ctrl+C 停止');
  console.log('');

  // Auto-open browser (works in both dev and packaged exe)
  const platform = process.platform;
  const cmd = platform === 'win32' ? 'start' : platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    require('child_process').exec(`${cmd} ${url}`);
  } catch (_) {
    // ignore — opening the browser is optional
  }
});
