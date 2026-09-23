#!/usr/bin/env python3
"""Manage only this user's product-res SSH control socket; never kill by port."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
from urllib.error import URLError
from urllib.request import urlopen


def health(port: int) -> bool:
    try:
        with urlopen(f"http://127.0.0.1:{port}/api/v1/health", timeout=5) as response:
            result = json.load(response)
        return result.get("service") == "product-res" and result.get("mode") == "pilot"
    except (OSError, URLError, ValueError):
        return False


def main() -> int:
    parser = argparse.ArgumentParser(
        description="试点隧道：start/status/restart/stop；仅管理本工具创建的连接"
    )
    parser.add_argument("action", choices=("start", "status", "restart", "stop"))
    parser.add_argument(
        "--ssh-target", required=True, help="管理员分配的专用 SSH 用户或本机 SSH 别名"
    )
    parser.add_argument("--port", type=int, default=18081)
    args = parser.parse_args()
    if (
        not 1024 <= args.port <= 65535
        or args.ssh_target.startswith("-")
        or any(c.isspace() for c in args.ssh_target)
    ):
        parser.error("端口须在 1024–65535，SSH 目标不得是选项或含空白")
    runtime = Path(f"/tmp/product-res-tunnel-{os.getuid()}")
    runtime.mkdir(mode=0o700, exist_ok=True)
    if runtime.is_symlink() or runtime.stat().st_uid != os.getuid():
        parser.error("隧道状态目录归属异常")
    runtime.chmod(0o700)
    token = hashlib.sha256(f"{args.ssh_target}:{args.port}".encode()).hexdigest()[:16]
    socket = str(runtime / token)
    control = ["ssh", "-S", socket, "-o", "BatchMode=yes", "-o", "ConnectTimeout=8"]

    def managed() -> bool:
        return (
            subprocess.run(
                control + ["-O", "check", args.ssh_target], capture_output=True
            ).returncode
            == 0
        )

    connected = managed()
    if args.action == "status":
        ready = health(args.port)
        print(
            json.dumps(
                {
                    "managed_tunnel": connected,
                    "pilot_healthy": ready,
                    "url": f"http://127.0.0.1:{args.port}",
                    "hint": "隧道断开时运行 start；服务不可用时请管理员检查 ECS",
                },
                ensure_ascii=False,
            )
        )
        return 0 if ready else 1
    if args.action in {"stop", "restart"} and connected:
        subprocess.run(control + ["-O", "exit", args.ssh_target], check=True, capture_output=True)
        connected = False
    if args.action == "stop":
        print("已停止本工具管理的隧道；其他连接未改动。")
        return 0
    if not connected:
        if health(args.port):
            print("本地入口已可用，使用现有连接；本工具不会接管或终止该连接。")
            return 0
        result = subprocess.run(
            control
            + [
                "-M",
                "-fNT",
                "-o",
                "ExitOnForwardFailure=yes",
                "-o",
                "ServerAliveInterval=15",
                "-o",
                "ServerAliveCountMax=3",
                "-o",
                "IPQoS=none",
                "-L",
                f"127.0.0.1:{args.port}:127.0.0.1:18081",
                args.ssh_target,
            ],
            capture_output=True,
            text=True,
        )
        if result.returncode:
            print(
                "隧道未能启动：请检查 SSH 授权、主机指纹、网络及本地端口占用。已有连接不会被终止。",
                file=sys.stderr,
            )
            return 1
    ready = health(args.port)
    print(
        f"http://127.0.0.1:{args.port} — "
        + ("试点服务可用" if ready else "SSH 已建立，应用健康检查失败；请管理员检查 ECS 服务")
    )
    return 0 if ready else 1


if __name__ == "__main__":
    raise SystemExit(main())
