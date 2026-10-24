"""Offline gzip cost/ratio probe on generated mixed agent-like JSON.
No profile data, credentials, network calls, or model API calls are used.
"""
import gzip
import json
import random
import statistics
import time

rng = random.Random(843)
words = ["session", "request", "message", "assistant", "tool", "response", "content", "reasoning", "stream", "status", "repository", "function", "payload", "client", "server", "context", "analysis", "result", "file", "output", "error", "token"]
code = [
    'const {name} = require("{mod}");',
    'function {fn}({arg}) {{ return {expr}; }}',
    'if ({arg} == null) throw new Error("{msg}");',
    'export async function {fn}() {{',
    '  await {fn}({arg});',
    '  return {expr};',
    '}}',
]
modules = ["node:fs", "node:path", "node:crypto", "./client", "./state", "./transport", "./utils"]
names = ["loadSession", "sendMessage", "writeFile", "parseResponse", "prepareRequest", "handleEvent", "resolveToken", "streamResponse"]
args = ["request", "session", "response", "payload", "controller", "message", "result", "options"]
expressions = ["response.data", "JSON.stringify(payload)", "messages.length > 0", "await client.fetch(request)", "state.currentSession", "Buffer.from(content)"]

def make_payload(minimum_bytes):
    messages = []
    while True:
        lines = []
        for _ in range(24):
            template = code[rng.randrange(len(code))]
            lines.append(template.format(name=rng.choice(names), mod=rng.choice(modules), fn=rng.choice(names), arg=rng.choice(args), expr=rng.choice(expressions), msg="invalid " + rng.choice(words)))
        prose = " ".join(" ".join(rng.sample(words, 6)) + "." for _ in range(8))
        output = "\n".join(f"[{rng.randrange(1000, 9999)}] {rng.choice(words)} {rng.choice(names)} completed in {rng.randrange(1, 900)}ms" for _ in range(18))
        messages.append({"role": "user" if len(messages) % 2 == 0 else "assistant", "content": prose + "\n```js\n" + "\n".join(lines) + "\n```\n" + output})
        envelope = {
            "model": "representative-agent",
            "system": "You are a coding agent. Inspect repository files, propose focused changes, and return a concise explanation.",
            "tools": [{"name": name, "description": f"{name} repository tool that accepts an input and returns a result."} for name in ["Read", "Edit", "Grep", "Bash", "Search"]],
            "messages": messages,
        }
        body = json.dumps(envelope, separators=(",", ":")).encode()
        if len(body) >= minimum_bytes:
            return body

for minimum in (64 * 1024, 256 * 1024):
    body = make_payload(minimum)
    print(f"payload_bytes={len(body)}")
    for level in (1, 6):
        compressed = gzip.compress(body, compresslevel=level, mtime=0)
        batches = []
        for _ in range(7):
            start = time.perf_counter_ns()
            for _ in range(10):
                gzip.compress(body, compresslevel=level, mtime=0)
            batches.append((time.perf_counter_ns() - start) / 10 / 1e6)
        cpu_ms = statistics.median(batches)
        print(f"gzip_level={level} compressed_bytes={len(compressed)} ratio={len(compressed)/len(body):.3f} median_cpu_ms={cpu_ms:.3f} theoretical_upload_saved_ms_10Mbps={(len(body)-len(compressed))*8/10_000_000*1000:.1f} theoretical_upload_saved_ms_100Mbps={(len(body)-len(compressed))*8/100_000_000*1000:.1f}")
