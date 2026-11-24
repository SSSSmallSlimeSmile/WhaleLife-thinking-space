const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

function argOf(name) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : '';
}
const parentPid = Number(argOf('--parent-pid') || 0);
const rawPort = String(argOf('--port') || process.env.WORKBENCH_PORT || '').trim();
const host = '127.0.0.1';
const rawUpstreamUrl = argOf('--upstream-url');
const rawUpstream = String(argOf('--upstream') || process.env.WORKBENCH_WHALE_PORT || '').trim();
if (!rawPort || (!rawUpstreamUrl && !rawUpstream)) {
  console.error('缺少端口参数：画布没有默认端口。必须显式给 --port <端口> --upstream-url <宿主 URL>（或 --upstream <宿主端口>）。');
  process.exit(2);
}
const port = Number(rawPort);
const target = rawUpstreamUrl ? new URL(rawUpstreamUrl) : null;
if (target && !['http:', 'https:'].includes(target.protocol)) throw new Error('--upstream-url 必须是 HTTP 或 HTTPS 地址。');
const upstream = target ? Number(target.port || (target.protocol === 'https:' ? 443 : 80)) : Number(rawUpstream);
const upstreamHost = target ? target.hostname.replace(/^\[|\]$/g, '') : host;
const upstreamHttp = target?.protocol === 'https:' ? https : http;
if (![port, upstream].every(value => Number.isInteger(value) && value > 0 && value <= 65535) || port === upstream) {
  throw new Error('请选择两个不同的有效端口。');
}
// 宿主挂在子路径下时（例如 http://127.0.0.1:9272/review-prefix），转发必须带上这段前缀，
// 否则页面里的 /plugins/... 会被投到根上，直接 404。
const upstreamPath = (argOf('--upstream-path') || process.env.WORKBENCH_WHALE_PATH || '').replace(/\/+$/, '');
if (upstreamPath && !/^\/[A-Za-z0-9._~\-/]*$/.test(upstreamPath)) throw new Error('--upstream-path 不合法：' + upstreamPath);
const upPath = (u) => {
  const raw = typeof u === 'string' && u ? u : '/';
  const tail = raw.startsWith('/') ? raw : '/' + raw;
  if (!upstreamPath || tail === upstreamPath || tail.startsWith(upstreamPath + '/')) return tail;
  return upstreamPath + tail;
};
const origin = `http://${host}:${port}`;
const targetOrigin = target?.origin ?? `http://${host}:${upstream}`;
const targetAuthority = target?.host ?? `${host}:${upstream}`;
const identityRoute = 'GET /api/workbench/identity';
const allowedRoutes = new Set(['POST /api/login', 'GET /api/status', 'GET /api/session/current', 'POST /plugins/workbench-readonly/search-read', identityRoute, 'GET /api/session', 'GET /api/official-plugins', 'POST /api/official-plugins/apply', 'GET /api/community-plugins', 'POST /api/community-plugins/apply', 'GET /plugins/thinking-space/flows', 'POST /plugins/thinking-space/flows', 'GET /plugins/thinking-space/skill', 'GET /plugins/thinking-space/tools', 'GET /plugins/thinking-space/skills', 'POST /plugins/thinking-space/publish', 'GET /plugins/thinking-space/comfy-bridge/flows']);
function localHost(req) {
  return req.headers.host === `${host}:${port}`;
}
function allowed(req) {
  return localHost(req) &&
    (!req.headers.origin || req.headers.origin === origin) &&
    (!req.headers['sec-fetch-site'] || ['same-origin', 'none'].includes(req.headers['sec-fetch-site']));
}
function headers(req) {
  return { ...req.headers, host: targetAuthority, origin: targetOrigin };
}
// 首页文件名：index.html 优先；否则认浏览器下载默认名 canvas-index.html；
// 再否则用目录里唯一的 .html。
function resolveHtml() {
  const direct = path.join(__dirname, 'index.html');
  if (fs.existsSync(direct)) return direct;
  const alt = path.join(__dirname, 'canvas-index.html');
  if (fs.existsSync(alt)) return alt;
  try {
    const htmls = fs.readdirSync(__dirname).filter((n) => n.toLowerCase().endsWith('.html'));
    if (htmls.length === 1) return path.join(__dirname, htmls[0]);
  } catch {}
  return direct;
}
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && ['/','/index.html'].includes(req.url.split('?')[0])) {
    // A link from another app may mark a top-level navigation as cross-site.
    const normalNavigation=req.headers['sec-fetch-mode']==='navigate'&&req.headers['sec-fetch-dest']==='document';
    if (!localHost(req)||(!normalNavigation&&!allowed(req))) { res.writeHead(403).end(); return; }
    res.writeHead(200, {'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY'});
    const file = fs.createReadStream(resolveHtml());
    file.on('error', () => res.destroy());
    file.pipe(res);
    return;
  }
  if (req.method === 'GET' && (req.url.startsWith('/market/') || req.url.startsWith('/plugins/thinking-space/'))) {
    if (!allowed(req)) { res.writeHead(403).end(); return; }
    const request = upstreamHttp.request({hostname:upstreamHost,port:upstream,path:upPath(req.url),method:'GET',headers:headers(req)}, response => {
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
  const request = upstreamHttp.request({hostname:upstreamHost,port:upstream,path:isIdentity?upPath('/api/status'):upPath(req.url),method:req.method,headers:headers(req)}, async response => {
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
  const request = upstreamHttp.request({hostname:upstreamHost,port:upstream,path:upPath(req.url),method:'GET',headers:headers(req)});
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
    const socket = net.connect({ host: upstreamHost, port: upstream });
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
// 父进程没了就别留着占端口：宿主被硬杀时插件进程来不及收尾，这条是最后的兜底。
// 只认启动时给的 --parent-pid；手动跑脚本不带这个参数就没有看护。
if (Number.isInteger(parentPid) && parentPid > 0) {
  const watch = setInterval(() => {
    try { process.kill(parentPid, 0); }
    catch { clearInterval(watch); console.log('父进程已退出，画布跟着收掉。'); process.exit(0); }
  }, 2000);
  watch.unref?.();
}
