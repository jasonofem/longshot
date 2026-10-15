// Minimal static server that hands out the shipping tarball to the user's browser.
// Serves an index page and the tarball itself on port 8080 bound to 0.0.0.0.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const TARBALL = '/home/user/longshot-live.tar.gz';
const PORT = 8080;

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);

  if (url === '/longshot-live.tar.gz') {
    try {
      const stat = fs.statSync(TARBALL);
      res.writeHead(200, {
        'Content-Type': 'application/gzip',
        'Content-Length': stat.size,
        'Content-Disposition': 'attachment; filename="longshot-live.tar.gz"',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      });
      fs.createReadStream(TARBALL).pipe(res);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('tarball missing: ' + err.message);
    }
    return;
  }

  let size = '?';
  try {
    size = fs.statSync(TARBALL).size;
  } catch {}

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`<!doctype html>
<html><head><meta charset="utf-8"><title>LONGSHOT download</title>
<style>
body{background:#070a0c;color:#e6f2ea;font-family:system-ui,-apple-system,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0}
.card{background:#0d161a;border:1px solid #1d2c33;border-radius:14px;padding:36px 44px;max-width:580px;text-align:center;box-shadow:0 20px 50px rgba(0,0,0,0.8)}
h1{margin:0 0 10px;font-size:24px;color:#fff}
p{color:#93a8ad;line-height:1.5;margin:8px 0}
a.dl{display:inline-block;margin:20px 0;padding:14px 32px;background:#3ddc97;color:#041209;border-radius:10px;text-decoration:none;font-size:17px;font-weight:700;transition:background .15s}
a.dl:hover{background:#4df3ab}
code{background:#16232a;padding:3px 8px;border-radius:6px;font-size:12px;color:#3ddc97;word-break:break-all}
small{color:#657a80;font-size:12px}
</style></head>
<body><div class="card">
<h1>LONGSHOT — Shipping Archive</h1>
<p>Weekly longshot-accumulator portfolio engine (zero npm dependencies, Node 20+, ESM + static dashboard).</p>
<p>Click below to download <b>longshot-live.tar.gz</b> (${size} bytes) to your Downloads folder.</p>
<a class="dl" href="/longshot-live.tar.gz">⬇ Download longshot-live.tar.gz</a>
<p><small>If the link opens in browser rather than downloading, right-click → “Save link as…”</small></p>
</div></body></html>`);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`LONGSHOT download server listening on 0.0.0.0:${PORT}`);
});
