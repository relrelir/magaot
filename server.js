'use strict';
const http = require('http');
const fs   = require('fs');
const path = require('path');
const url  = require('url');

const PORT     = process.env.PORT || 3456;
const BASE_DIR = __dirname;

http.createServer((req, res) => {
  const pathname = url.parse(req.url).pathname;
  const target   = pathname === '/' ? '/magaot_app.html' : pathname;
  const file     = path.join(BASE_DIR, target);

  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const mime = {
      '.html': 'text/html; charset=utf-8',
      '.js':   'text/javascript',
      '.css':  'text/css',
      '.json': 'application/json'
    }[path.extname(file).toLowerCase()] || 'text/plain';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
}).listen(PORT, () => console.log('מגירות server: http://localhost:' + PORT));
