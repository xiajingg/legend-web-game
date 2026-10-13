'use strict';

/**
 * 入口：起 HTTP 服务、加载账号、启动世界循环。
 * 0 依赖，直接 node server/index.js 即可运行。
 */

const http = require('node:http');
const { PORT } = require('./config');
const store = require('./store');
const sse = require('./sseHub');
const world = require('./game/world');
const { route } = require('./httpRouter');

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    console.error('[http] 处理异常:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    }
    res.end(JSON.stringify({ ok: false, msg: '服务器内部错误' }));
  });
});

// SSE 需要长连接不被超时掐断
server.keepAliveTimeout = 0;
server.headersTimeout = 0;

async function main() {
  await store.loadAccounts();
  world.startLoops();

  server.listen(PORT, () => {
    console.log('=============================================');
    console.log(`  传奇类网页游戏已启动`);
    console.log(`  打开浏览器访问: http://localhost:${PORT}`);
    console.log(`  停止服务: Ctrl+C`);
    console.log('=============================================');
  });
}

async function shutdown(signal) {
  console.log(`\n[shutdown] 收到 ${signal}，正在保存存档...`);
  sse.closeAll();
  try {
    await world.saveAll();
    console.log('[shutdown] 存档已保存');
  } catch (e) {
    console.error('[shutdown] 保存失败:', e);
  }
  server.close(() => process.exit(0));
  // 兜底：5 秒后强制退出
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((e) => {
  console.error('[fatal] 启动失败:', e);
  process.exit(1);
});
