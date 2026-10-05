#!/bin/bash
# PhiChart Editor 本地启动（macOS）
#
# 等价于 Windows 的「启动渲染器.cmd」：定位可用的 Python 3，启动 tools/dev_server.py，
# 并自动打开浏览器。在访达里双击本文件，或在项目根目录执行 ./启动渲染器.command。
#
# 环境变量：
#   PHICHART_PORT        端口，默认 8099
#   PHICHART_HOST        绑定地址，默认 0.0.0.0（对局域网开放）；只给本机用设 127.0.0.1
#   PHICHART_NO_BROWSER  设为 1 则不自动打开浏览器
#   PHICHART_PYTHON      指定 python3 可执行文件，覆盖自动探测
#
# 首次从访达双击若提示「无法打开」，执行一次：
#   chmod +x 启动渲染器.command

cd "$(dirname "$0")" || exit 1

PORT="${PHICHART_PORT:-8099}"
HOST="${PHICHART_HOST:-0.0.0.0}"

# 定位可用的 Python 3：PATH 优先，其次常见安装位置（Homebrew / python.org / 系统自带）。
# 逐个做版本探测，避免选中不存在的存根（未装命令行工具时的 /usr/bin/python3）。
find_python() {
  local candidate resolved
  for candidate in "${PHICHART_PYTHON:-}" python3 \
                   /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do
    [ -n "$candidate" ] || continue
    command -v "$candidate" >/dev/null 2>&1 || continue
    "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 7) else 1)' >/dev/null 2>&1 || continue
    resolved="$(command -v "$candidate")"
    printf '%s\n' "$resolved"
    return 0
  done
  return 1
}

if ! PY="$(find_python)"; then
  echo "[ERROR] 没有找到可用的 Python 3。"
  echo "  方式一：安装 Python 3  https://www.python.org/downloads/"
  echo "  方式二：安装 Node.js 后在项目根目录执行：npx --yes serve -l ${PORT} ."
  echo "  然后打开 http://127.0.0.1:${PORT}/index.html"
  read -r -p "按回车键关闭…" _
  exit 1
fi

echo "Project  : $PWD"
echo "Python   : $PY"
echo "Server   : $PY tools/dev_server.py --host $HOST --port $PORT"
echo "Start    : http://127.0.0.1:$PORT/index.html   (open project / package / new project)"
echo "Player   : http://127.0.0.1:$PORT/player.html"
echo "Editor   : http://127.0.0.1:$PORT/edit.html"
if [ "$HOST" = "0.0.0.0" ]; then
  echo "LAN      : 局域网其他设备可用 http://本机IP:$PORT/edit.html（下面会列出具体地址）"
else
  echo "LAN      : 仅本机（要对局域网开放：PHICHART_HOST=0.0.0.0）"
fi
echo "Stop     : 在本窗口按 Ctrl+C"
echo

if [ "${PHICHART_NO_BROWSER:-0}" != "1" ]; then
  # 等服务器监听后再打开，免得浏览器先到一步拿到「无法连接」
  ( sleep 2; open "http://127.0.0.1:$PORT/index.html" ) &
fi

# 用自带服务器（显式缓存校验头，默认监听全部网卡）；
# python -m http.server 不发缓存头，会让浏览器缓存住旧模块，出现「页面新、模块旧」的混搭故障。
if [ -f tools/dev_server.py ]; then
  exec "$PY" tools/dev_server.py --host "$HOST" --port "$PORT"
fi

echo "[WARN] 找不到 tools/dev_server.py，退回 python -m http.server（缓存可能导致新旧脚本混搭）"
exec "$PY" -m http.server "$PORT" --bind "$HOST"
