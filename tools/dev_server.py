"""开发用静态服务器（带 Cache-Control: no-store，默认对局域网开放）。

为什么不用 `python -m http.server`：
    它不发任何缓存头，浏览器会对 ES 模块做**启发式缓存**。于是很容易出现
    「页面已经更新、但某个 .js / 谱面 JSON 还是旧的」这种混搭状态，表现就是各种说不清的怪现象：
    改了没反应、提示成功但面板还显示旧值、结构树里的层数对不上……
    （这个项目已经因为缓存混搭排查过两次。）
    这里显式禁止缓存，保证每次刷新拿到的都是同一套文件。

用法：
    python tools/dev_server.py                                  默认 8099，绑定 0.0.0.0（局域网可访问）
    python tools/dev_server.py 8100                             换端口
    python tools/dev_server.py --host 127.0.0.1                 只允许本机访问
    PHICHART_HOST / PHICHART_PORT 环境变量同样生效（启动渲染器.cmd 用它们）
"""

import os
import socket
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def parse_args(argv):
    port = int(os.environ.get("PHICHART_PORT") or 8099)
    host = os.environ.get("PHICHART_HOST") or "0.0.0.0"
    rest = list(argv)
    i = 0
    while i < len(rest):
        a = rest[i]
        if a in ("--port", "-p") and i + 1 < len(rest):
            port = int(rest[i + 1])
            i += 2
            continue
        if a in ("--host", "-H") and i + 1 < len(rest):
            host = rest[i + 1]
            i += 2
            continue
        if a.isdigit():
            port = int(a)
        i += 1
    return host, port


def lan_addresses():
    """本机在局域网里的 IPv4 地址（取不到就返回空列表，不报错）"""
    out = []
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if ip not in out and not ip.startswith("127."):
                out.append(ip)
    except OSError:
        pass
    if not out:
        # 退路：连一个外部地址（UDP 不会真的发包），看内核选了哪张网卡
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("8.8.8.8", 80))
            out.append(s.getsockname()[0])
            s.close()
        except OSError:
            pass
    return out


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # 关键：禁止缓存，避免新旧脚本 / 新旧谱面混搭
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        # 只报错误，正常请求不刷屏（编辑器会频繁拉模块）
        status = args[1] if len(args) > 1 else ""
        if str(status).startswith(("4", "5")):
            super().log_message(fmt, *args)


def main():
    # 从 .cmd / 后台运行时 stdout 是管道（块缓冲），地址会迟迟不打印 —— 改成行缓冲
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except (AttributeError, ValueError):
        pass
    host, port = parse_args(sys.argv[1:])
    handler = partial(NoCacheHandler, directory=ROOT)
    try:
        httpd = ThreadingHTTPServer((host, port), handler)
    except OSError as err:
        print(f"[ERROR] 无法绑定 {host}:{port} —— {err}")
        print("        端口被占用就换一个：python tools/dev_server.py 8100")
        return 1

    local = f"http://127.0.0.1:{port}"
    print(f"Project  : {ROOT}")
    print(f"Server   : {host}:{port}   (Cache-Control: no-store)")
    print(f"Start    : {local}/start.html   (open project / package / new project)")
    print(f"Player   : {local}/index.html")
    print(f"Editor   : {local}/edit.html")
    if host in ("0.0.0.0", "::", ""):
        ips = lan_addresses()
        if ips:
            print("LAN      : 同一局域网的其他设备用这些地址打开")
            for ip in ips:
                print(f"           http://{ip}:{port}/edit.html")
        else:
            print("LAN      : 已监听全部网卡（没取到局域网 IP，用 ipconfig 查一下）")
        if sys.platform == "win32":
            print("           首次运行 Windows 防火墙会弹窗，要选「允许访问」其他设备才连得上")
    else:
        print("LAN      : 仅本机可访问（--host 0.0.0.0 可对局域网开放）")
    print("Stop     : Ctrl+C in this window")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
