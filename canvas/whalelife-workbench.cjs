const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

function argOf(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}
const port = Number(argOf('--port') || process.env.WORKBENCH_PORT || 9281);
const upstream = Number(argOf('--upstream') || process.env.WORKBENCH_WHALE_PORT || 9270);
if (![port, upstream].every(value => Number.isInteger(value) && value > 0 && value <= 65535) || port === upstream) {
  throw new Error('请选择两个不同的有效端口。');
}
const host = '127.0.0.1';
const origin = `http://${host}:${port}`;
const targetOrigin = `http://${host}:${upstream}`;
const identityRoute = 'GET /api/workbench/identity';
const allowedRoutes = new Set(['POST /api/login', 'GET /api/session/current', 'POST /plugins/workbench-readonly/search-read', identityRoute, 'GET /api/session', 'GET /api/official-plugins', 'GET /plugins/thinking-space/flows', 'POST /plugins/thinking-space/flows', 'GET /plugins/thinking-space/skill', 'GET /plugins/thinking-space/tools']);
function localHost(req) {
  return req.headers.host === `${host}:${port}`;
}
function allowed(req) {
  return localHost(req) &&
    (!req.headers.origin || req.headers.origin === origin) &&
    (!req.headers['sec-fetch-site'] || ['same-origin', 'none'].includes(req.headers['sec-fetch-site']));
}
function headers(req) {
  return { ...req.headers, host: `${host}:${upstream}`, origin: targetOrigin };
}
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && ['/','/index.html'].includes(req.url.split('?')[0])) {
    // A link from another app may mark a top-level navigation as cross-site.
    const normalNavigation=req.headers['sec-fetch-mode']==='navigate'&&req.headers['sec-fetch-dest']==='document';
    if (!localHost(req)||(!normalNavigation&&!allowed(req))) { res.writeHead(403).end(); return; }
    res.writeHead(200, {'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY'});
    const file = fs.createReadStream(path.join(__dirname, 'index.html'));
    file.on('error', () => res.destroy());
    file.pipe(res);
    return;
  }
  if (req.method === 'GET' && (req.url.startsWith('/market/') || req.url.startsWith('/plugins/thinking-space/'))) {
    if (!allowed(req)) { res.writeHead(403).end(); return; }
    const request = http.request({hostname:host,port:upstream,path:req.url,method:'GET',headers:headers(req)}, response => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    });
    request.on('error', () => {
      if(!res.headersSent)res.writeHead(502,{'Content-Type':'text/plain; charset=utf-8'}).end('上游 WhaleLife 不可用');
      else res.destroy();
    });
    request.end();
    return;
  }
  if (!allowed(req)) { res.writeHead(403).end(); return; }
  const route=req.method+' '+req.url.split('?')[0];
  if (!allowedRoutes.has(route)) { res.writeHead(404).end(); return; }
  const isIdentity=route===identityRoute;
  const request = http.request({hostname:host,port:upstream,path:isIdentity?'/api/status':req.url,method:req.method,headers:headers(req)}, async response => {
    if(isIdentity){
      const send=(status,data)=>res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}).end(JSON.stringify(data));
      if(response.statusCode!==200){
        response.resume();
        send(response.statusCode,{error:'无法读取 WhaleLife 当前人格。'});
        return;
      }
      try{
        let body='';
        response.setEncoding('utf8');
        for await(const chunk of response){
          body+=chunk;
          if(body.length>1_000_000)throw Error('Status response too large');
        }
        const {personaName}=JSON.parse(body);
        send(200,{name:typeof personaName==='string'?personaName:null});
      }catch{send(502,{error:'无法读取 WhaleLife 当前人格。'});}
      return;
    }
    res.writeHead(response.statusCode, response.headers);
    response.pipe(res);
  });
  request.on('error', () => {
    if(res.destroyed)return;
    if(res.headersSent){res.destroy();return;}
    res.writeHead(502, {'Content-Type':'application/json; charset=utf-8'}).end(JSON.stringify({error:'无法连接本机 WhaleLife，请确认宿主已启动。'}));
  });
  res.once('close',()=>{if(!res.writableFinished)request.destroy();});
  req.pipe(request);
});
server.on('upgrade', (req, socket, head) => {
  if (!allowed(req) || req.headers.origin !== origin || req.url !== '/ws/chat' || req.headers.upgrade?.toLowerCase() !== 'websocket') {
    socket.destroy();
    return;
  }
  const request = http.request({hostname:host,port:upstream,path:req.url,method:'GET',headers:headers(req)});
  request.on('upgrade', (response, remote, buffered) => {
    if (socket.destroyed) { remote.destroy(); return; }
    const lines = ['HTTP/1.1 101 Switching Protocols'];
    for (let i = 0; i < response.rawHeaders.length; i += 2) lines.push(response.rawHeaders[i]+': '+response.rawHeaders[i+1]);
    socket.write(lines.join('\r\n')+'\r\n\r\n');
    if (buffered.length) socket.write(buffered);
    if (head.length) remote.write(head);
    socket.on('error', () => remote.destroy());
    remote.on('error', () => socket.destroy());
    socket.on('close', () => remote.destroy());
    remote.on('close', () => socket.destroy());
    socket.pipe(remote).pipe(socket);
  });
  request.on('response', response => { response.resume(); socket.destroy(); });
  request.on('error', () => socket.destroy());
  socket.on('error', () => request.destroy());
  request.end();
});
// 看门狗：宿主关掉后自己退出。宿主没了，这个代理也就没用了。
if (process.env.WORKBENCH_WATCH_PARENT !== '0') {
  const net = require('node:net');
  const graceMs = Number(process.env.WORKBENCH_WATCH_GRACE_MS || 15000);
  const intervalMs = 3000;
  const probeTimeoutMs = 2000;
  const maxMisses = 2;
  const startedAt = Date.now();
  let misses = 0;
  let stopped = false;
  const stop = (reason) => {
    if (stopped) return;
    stopped = true;
    console.log('宿主已退出，画布随之关闭：' + reason);
    process.exit(0);
  };
  const probe = () => {
    if (stopped || Date.now() - startedAt < graceMs) return;
    const socket = net.connect({ host, port: upstream });
    let settled = false;
    const settle = (hit) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (hit) { misses = 0; return; }
      misses += 1;
      if (misses >= maxMisses) stop('连续 ' + misses + ' 次连不上 ' + upstream);
    };
    socket.setTimeout(probeTimeoutMs, () => settle(false));
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
  };
  setInterval(probe, intervalMs);
}
server.listen(port, host, () => console.log('许愿一个功能 · '+origin));
