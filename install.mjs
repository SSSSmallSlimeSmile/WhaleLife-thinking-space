#!/usr/bin/env node
// 一键安装 thinking-space：下载 Release 资产、校验、解压到宿主 plugins 目录。
// 用法：
//   node install.mjs                         在宿主目录里跑（自动找 ./plugins）
//   node install.mjs --host "K:\WhaleLife\whalelife"
//   node install.mjs --file thinking-space-0.1.0.wlpkg.gz    用本地包，不联网
//   node install.mjs --force                 覆盖已存在的插件目录

import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import zlib from "node:zlib";
import crypto from "node:crypto";

const REPO = "SSSSmallSlimeSmile/WhaleLife-thinking-space";
const VERSION = "0.1.0";
const ASSET = `thinking-space-${VERSION}.wlpkg.gz`;
const ASSET_URL = `https://github.com/${REPO}/releases/download/v${VERSION}/${ASSET}`;
const PLUGIN_ID = "thinking-space";

function arg(name, fallback = "") {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith("--") ? next : "true";
}

function log(msg) {
  console.log(msg);
}

function die(msg) {
  console.error(`\n安装失败：${msg}`);
  process.exit(1);
}

function download(url, redirects = 0) {
  if (redirects > 5) return Promise.reject(new Error("重定向次数过多"));
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { "user-agent": "thinking-space-installer" } },
      res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          resolve(download(new URL(res.headers.location, url).toString(), redirects + 1));
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`下载失败：HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.setTimeout(60000, () => req.destroy(new Error("下载超时")));
  });
}

function parsePackage(buf) {
  let raw;
  try {
    raw = zlib.gunzipSync(buf);
  } catch {
    die("不是有效的 .wlpkg.gz 文件（gunzip 失败）");
  }
  const nl = raw.indexOf(0x0a);
  if (nl < 0) die("包头缺失（找不到换行）");
  let head;
  try {
    head = JSON.parse(raw.subarray(0, nl).toString("utf8"));
  } catch {
    die("包头不是合法 JSON");
  }
  if (head.format !== 1) die(`不认识的包格式：${head.format}`);
  const files = [];
  let off = nl + 1;
  for (const item of head.files) {
    const body = raw.subarray(off, off + item.size);
    off += item.size;
    const actual = crypto.createHash("sha256").update(body).digest("hex");
    if (actual !== item.sha256) die(`校验失败：${item.path}（期望 ${item.sha256.slice(0, 12)}，实际 ${actual.slice(0, 12)}）`);
    files.push({ path: item.path, body });
  }
  if (off !== raw.length) die(`包长度对不上：清单 ${off} 字节，实际 ${raw.length} 字节`);
  return files;
}

function findPluginsDir() {
  const host = arg("host");
  const root = path.resolve(host || process.cwd());
  const plugins = path.join(root, "plugins");
  if (!fs.existsSync(plugins)) {
    die(`找不到 ${plugins}\n用 --host 指定宿主目录，例如：--host "K:\\WhaleLife\\whalelife"`);
  }
  return plugins;
}

const pluginsDir = findPluginsDir();
const target = path.join(pluginsDir, PLUGIN_ID);
const force = arg("force") === "true";

if (fs.existsSync(target) && !force) {
  die(`${target} 已存在。\n要覆盖请加 --force（原有 data/ 会被保留，只覆盖代码文件）`);
}

const localFile = arg("file");
let pkg;
if (localFile) {
  if (!fs.existsSync(localFile)) die(`找不到本地包：${localFile}`);
  log(`读本地包 ${localFile}`);
  pkg = fs.readFileSync(localFile);
} else {
  log(`下载 ${ASSET_URL}`);
  pkg = await download(ASSET_URL);
}
log(`包大小 ${pkg.length} 字节`);

const files = parsePackage(pkg);
log(`清单 ${files.length} 个文件，全部校验通过`);

fs.mkdirSync(target, { recursive: true });
for (const f of files) {
  const dest = path.join(target, f.path);
  const dir = path.dirname(dest);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(dest, f.body);
}
log(`已释放到 ${target}`);

// 写一个安装记录，方便以后核对版本
const stamp = {
  id: PLUGIN_ID,
  version: VERSION,
  installedAt: new Date().toISOString(),
  source: localFile || ASSET_URL,
  sha256: crypto.createHash("sha256").update(pkg).digest("hex"),
};
fs.mkdirSync(path.join(target, "data"), { recursive: true });
fs.writeFileSync(path.join(target, "data", "install.json"), JSON.stringify(stamp, null, 2) + "\n", "utf8");

log(`\n完成。下一步：重启宿主（或在插件页 reload），然后打开「插件页面 → 思维空间」。`);
if (!fs.existsSync(path.join(target, "data", "skills.json"))) {
  log(`技能库是空的，点「查看技能列表」开始建第一条。`);
}
