'use strict';

/**
 * 重置账号密码（离线工具，直接在 data/accounts.json 上操作）。
 *
 * 用法：
 *   node reset-password.js                 # 列出所有账号
 *   node reset-password.js <用户名> <新密码>  # 重置指定账号的密码
 *
 * 注意：游戏的账号表在服务进程里是内存缓存（store.js 的 `accounts`），
 *      改完文件后必须重启服务才会生效：
 *          ./server.sh restart
 *
 * 为什么不能"找回"旧密码：密码用 scrypt 单向哈希 + 随机盐存储，
 * 不可逆推。忘记只能重置。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ACCOUNTS_FILE = path.join(__dirname, 'data', 'accounts.json');

/** 与 server/auth.js 保持完全一致的哈希参数 */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}

function readAccounts() {
  try {
    return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
  } catch (e) {
    // 主文件损坏时回退 .bak，与 store.js 行为一致
    try {
      return JSON.parse(fs.readFileSync(ACCOUNTS_FILE + '.bak', 'utf8'));
    } catch (_) {
      console.error(`无法读取账号表：${ACCOUNTS_FILE}`);
      process.exit(1);
    }
  }
}

/** 原子写：先写 .tmp 再 rename，避免写一半损坏 */
function writeAccounts(accounts) {
  const tmp = ACCOUNTS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(accounts, null, 2), 'utf8');
  fs.renameSync(tmp, ACCOUNTS_FILE);
}

const [, , username, newPassword] = process.argv;
const accounts = readAccounts();

// ---- 无参数：列出所有账号 ----
if (!username) {
  const names = Object.keys(accounts);
  console.log(`账号表：${ACCOUNTS_FILE}`);
  console.log(`共 ${names.length} 个账号：\n`);
  for (const n of names) {
    const a = accounts[n];
    const created = a.createdAt ? new Date(a.createdAt).toLocaleString('zh-CN') : '未知';
    console.log(`  ${n.padEnd(18)} 创建于 ${created}`);
  }
  console.log('\n重置密码：node reset-password.js <用户名> <新密码>');
  process.exit(0);
}

// ---- 带参数：重置密码 ----
if (!newPassword) {
  console.error('用法：node reset-password.js <用户名> <新密码>');
  process.exit(1);
}
if (!accounts[username]) {
  console.error(`账号不存在：${username}`);
  console.error(`可用账号：${Object.keys(accounts).join(', ')}`);
  process.exit(1);
}
if (newPassword.length < 6) {
  console.error('密码至少 6 位');
  process.exit(1);
}

const { salt, hash } = hashPassword(newPassword);
// 保留原 createdAt，只换盐和哈希
accounts[username] = { ...accounts[username], salt, pwHash: hash };
writeAccounts(accounts);

console.log(`✅ 已重置 ${username} 的密码`);
console.log('');
console.log('⚠️  还需重启服务才会生效（账号表在进程内有内存缓存）：');
console.log('     ./server.sh restart');
