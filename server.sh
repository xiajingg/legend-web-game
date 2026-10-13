#!/usr/bin/env bash
#
# 游戏服务管理脚本（macOS / Linux 通用）
#
# 用法：
#   ./server.sh start     后台启动（日志写入 logs/server.log）
#   ./server.sh stop      停止服务
#   ./server.sh restart   重启
#   ./server.sh status    查看运行状态
#   ./server.sh log       实时查看日志（Ctrl+C 退出）
#
# 为什么需要这个脚本：
#   直接 `node server/index.js` 是前台进程，终端一关 / 会话一结束就被回收，
#   表现为"服务莫名其妙停了"。本脚本用 nohup 让进程脱离终端会话，
#   并把 PID 记到 logs/server.pid，方便精确停止。
#
set -u

# ---- 路径与参数（改端口就改这里，或用环境变量 PORT 覆盖）----
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$ROOT_DIR/logs/server.pid"
LOG_FILE="$ROOT_DIR/logs/server.log"
PORT="${PORT:-8099}"
NODE_BIN="$(command -v node || echo node)"

cd "$ROOT_DIR" || exit 1
mkdir -p "$ROOT_DIR/logs"

# 读取已记录的 PID（不存在则输出空）
read_pid() {
  [ -f "$PID_FILE" ] && cat "$PID_FILE" 2>/dev/null | tr -d '[:space:]'
}

# 判断某个 PID 是否真的还活着
is_alive() {
  local pid="$1"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

# 找出「正在监听」该端口的进程号（兜底：PID 文件丢了也能停掉）
# 注意：必须限定 -sTCP:LISTEN，否则浏览器到 8099 的客户端连接
#      （CLOSE_WAIT / ESTABLISHED）会被误判成"端口被占用"。
pid_by_port() {
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1
}

# ---------------------------------------------------------------- start
do_start() {
  local pid
  pid="$(read_pid)"
  if is_alive "$pid"; then
    echo "已在运行中 (PID=$pid, 端口 $PORT)，无需重复启动"
    return 0
  fi

  # 端口被别的进程占用时先提示，避免启动即失败
  local occupy
  occupy="$(pid_by_port)"
  if [ -n "$occupy" ]; then
    echo "端口 $PORT 已被进程 $occupy 占用，请先释放或改用其它端口："
    echo "  PORT=9000 ./server.sh start"
    return 1
  fi

  echo "正在启动游戏服务 (端口 $PORT)..."

  # 优先用 daemonize.py：走标准 Unix daemonize（双重 fork + setsid），
  # 进程彻底脱离当前会话，比单纯 nohup 更可靠。
  if [ -f "$ROOT_DIR/daemonize.py" ] && command -v python3 >/dev/null 2>&1; then
    PORT="$PORT" python3 "$ROOT_DIR/daemonize.py"
  else
    # 兜底：用子 shell + nohup 启动，同样能让进程脱离当前终端会话
    (
      nohup "$NODE_BIN" server/index.js >>"$LOG_FILE" 2>&1 &
      echo $! >"$PID_FILE"
    )
  fi

  # 等待端口就绪，最多约 5 秒
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if [ -n "$(pid_by_port)" ]; then
      pid="$(read_pid)"
      echo "启动成功 ✅  PID=$pid  端口=$PORT"
      echo "访问地址： http://localhost:$PORT"
      echo "日志文件： $LOG_FILE"
      return 0
    fi
    sleep 0.5
  done

  echo "启动失败 ❌ 请查看日志： $LOG_FILE"
  tail -n 20 "$LOG_FILE" 2>/dev/null
  return 1
}

# ----------------------------------------------------------------- stop
do_stop() {
  local pid
  pid="$(read_pid)"

  if ! is_alive "$pid"; then
    # PID 文件失效，用端口兜底查
    pid="$(pid_by_port)"
    if [ -z "$pid" ]; then
      echo "服务未在运行"
      rm -f "$PID_FILE"
      return 0
    fi
  fi

  echo "正在停止服务 (PID=$pid)..."
  kill "$pid" 2>/dev/null

  # 最多等 5 秒优雅退出（服务端会先存档再退出）
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    is_alive "$pid" || break
    sleep 0.5
  done

  if is_alive "$pid"; then
    echo "优雅退出超时，强制结束"
    kill -9 "$pid" 2>/dev/null
  fi

  rm -f "$PID_FILE"
  echo "已停止 ✅"
}

# --------------------------------------------------------------- status
do_status() {
  local pid
  pid="$(read_pid)"

  if is_alive "$pid"; then
    echo "运行中 ✅  PID=$pid  端口=$PORT"
    echo "访问地址： http://localhost:$PORT"
    echo "日志文件： $LOG_FILE"
  else
    local occupy
    occupy="$(pid_by_port)"
    if [ -n "$occupy" ]; then
      echo "PID 文件已失效，但端口 $PORT 被进程 $occupy 占用"
    else
      echo "未运行 ❌"
    fi
  fi
}

# ------------------------------------------------------------------ log
do_log() {
  if [ ! -f "$LOG_FILE" ]; then
    echo "日志文件尚不存在： $LOG_FILE"
    return 1
  fi
  tail -f "$LOG_FILE"
}

# -------------------------------------------------------------- dispatch
case "${1:-}" in
  start)   do_start ;;
  stop)    do_stop ;;
  restart) do_stop; sleep 0.5; do_start ;;
  status)  do_status ;;
  log)     do_log ;;
  *)
    echo "用法: $0 {start|stop|restart|status|log}"
    exit 1
    ;;
esac
