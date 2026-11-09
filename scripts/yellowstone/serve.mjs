// A static server for the GPU comparison page: /yellowstone/* is the site's Yellowstone folder, anything else is this folder. Nothing is cached.
//   node serve.mjs [port]      then open http://localhost:8099/gpu-compare.html in Chrome (it needs WebGPU)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const site = new URL('../../public/projects/yellowstone/', import.meta.url).pathname, here = new URL('.', import.meta.url).pathname;
const types = { '.js': 'text/javascript', '.html': 'text/html', '.json': 'application/json', '.css': 'text/css' };
http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  const root = u.startsWith('/yellowstone/') ? site : here, f = path.join(root, u.startsWith('/yellowstone/') ? u.slice('/yellowstone/'.length) : u);
  if (f.startsWith(root) && fs.existsSync(f) && fs.statSync(f).isFile()) { res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' }); fs.createReadStream(f).pipe(res); }
  else { res.writeHead(404); res.end('not found'); }
}).listen(+process.argv[2] || 8099, () => console.log('http://localhost:' + (+process.argv[2] || 8099) + '/gpu-compare.html'));
