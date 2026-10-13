#!/usr/bin/env python3
"""
把游戏服务以「守护进程」方式启动，彻底脱离当前进程组/会话。

原理：Unix 标准 daemonize 三步
  1. fork 一次，父进程退出  -> 子进程不再是终端进程组的组长
  2. setsid()              -> 新建会话，脱离原会话（不再收到终端的 SIGHUP）
  3. 再 fork 一次，父进程退出 -> 确保新进程不是会话首进程，无法再获得控制终端

这样启动的进程与调用它的 shell / 工具环境完全解耦。
"""
import os
import sys
import shutil
import subprocess

# 项目根目录 = 本脚本所在目录，不写死绝对路径，clone 到任何位置都能跑
ROOT = os.path.dirname(os.path.abspath(__file__))
# 依次尝试：环境变量 NODE_BIN -> PATH 里的 node -> 常见安装位置
NODE = os.environ.get("NODE_BIN") or shutil.which("node") or "/usr/local/bin/node"
PORT = os.environ.get("PORT", "8099")

os.chdir(ROOT)

# --- 第 1 次 fork：父进程立即退出 ---
if os.fork() > 0:
    os._exit(0)

# --- 新建会话，脱离控制终端 ---
os.setsid()

# --- 第 2 次 fork：防止重新获得控制终端 ---
if os.fork() > 0:
    os._exit(0)

# --- 到这里是最终的守护进程 ---
log = open(os.path.join(ROOT, "logs", "server.log"), "a")
env = dict(os.environ)
env["PORT"] = PORT

proc = subprocess.Popen(
    [NODE, "server/index.js"],
    cwd=ROOT,
    stdout=log,
    stderr=log,
    stdin=subprocess.DEVNULL,
    env=env,
)

with open(os.path.join(ROOT, "logs", "server.pid"), "w") as f:
    f.write(str(proc.pid))

sys.exit(0)
