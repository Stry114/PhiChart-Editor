"""最小 OpenAI 兼容 mock：POST /v1/chat/completions 返回 SSE 流式回复（浏览器烟雾测试用）。"""
import json
from http.server import BaseHTTPRequestHandler, HTTPServer


class H(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("access-control-allow-origin", "*")
        self.send_header("access-control-allow-methods", "POST, OPTIONS")
        self.send_header("access-control-allow-headers", "content-type, authorization")
        self.end_headers()

    def do_POST(self):
        n = int(self.headers.get("content-length", 0))
        body = json.loads(self.rfile.read(n) or b"{}")
        user_texts = [m.get("content", "") for m in body.get("messages", []) if m.get("role") == "user"]
        reply = f"收到：{user_texts[-1] if user_texts else ''}"
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("access-control-allow-origin", "*")
        self.end_headers()
        chunks = [
            {"choices": [{"delta": {"content": reply[: len(reply) // 2]}}]},
            {"choices": [{"delta": {"content": reply[len(reply) // 2 :]}}]},
            {"choices": [], "usage": {"prompt_tokens": 42, "completion_tokens": 21, "total_tokens": 63}},
        ]
        for c in chunks:
            self.wfile.write(f"data: {json.dumps(c)}\n\n".encode())
        self.wfile.write(b"data: [DONE]\n\n")

    def log_message(self, *a):
        pass


HTTPServer(("127.0.0.1", 8650), H).serve_forever()
