#!/usr/bin/env python3
"""PiForge agent-host 冷启动统计（读 main.log，输出每次启动的耗时表 + p50/p95）。

用法：
    python bench/startup_stats.py                 # 最近 20 次启动，人类可读表
    python bench/startup_stats.py --starts 3      # 只看最近 3 次
    python bench/startup_stats.py --json          # 机器可读
    python bench/startup_stats.py --log <path>    # 指定 main.log（默认 %APPDATA%/piforge/logs/main.log）

一次"启动"从 `Startup timing: app ready` 开始（elapsedMs=0）。
跨进程的量（spawn → host 第一行）用日志时间戳差，因为 elapsedMs 只在 Electron Main 里算。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

DEFAULT_LOG = Path(os.environ.get("APPDATA", "")) / "piforge" / "logs" / "main.log"

PHASE_RE = re.compile(r"\[phase\] (?P<name>[\w.\-]+) ms=(?P<ms>\d+) delta=(?P<delta>\d+)")
TIMING_PREFIX = "Startup timing: "


@dataclass
class Startup:
    started_at: datetime | None = None
    timings: dict[str, float] = field(default_factory=dict)
    stamps: dict[str, datetime] = field(default_factory=dict)
    heap_flags_at: datetime | None = None
    heap_detail: str = ""
    phases: list[tuple[str, int, int]] = field(default_factory=list)

    def ms_between(self, a: str, b: str) -> float | None:
        if a in self.timings and b in self.timings:
            return round(self.timings[b] - self.timings[a], 1)
        return None


def parse_ts(value: str) -> datetime | None:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return None


def collect(log_path: Path, limit: int) -> list[Startup]:
    starts: list[Startup] = []
    current: Startup | None = None
    with log_path.open("r", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            if '"Startup timing: app ready"' in line:
                current = Startup()
                starts.append(current)
            if current is None:
                continue
            if not line.startswith("{"):
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            message = record.get("message") or ""
            when = parse_ts(record.get("time") or "")
            if message.startswith(TIMING_PREFIX):
                label = message[len(TIMING_PREFIX):]
                detail = record.get("detail") or {}
                elapsed = detail.get("elapsedMs")
                if isinstance(elapsed, (int, float)):
                    current.timings[label] = float(elapsed)
                    if when:
                        current.stamps[label] = when
                    if label == "app ready":
                        current.started_at = when
            elif "heap flags" in message:
                current.heap_flags_at = when
                current.heap_detail = message.split("heap flags:")[-1].strip()
            else:
                match = PHASE_RE.search(message)
                if match:
                    current.phases.append(
                        (match.group("name"), int(match.group("ms")), int(match.group("delta")))
                    )
    return starts[-limit:] if limit > 0 else starts


def summarize(start: Startup) -> dict:
    def gap(a: datetime | None, b: datetime | None) -> float | None:
        if a and b:
            return round((b - a).total_seconds() * 1000, 1)
        return None

    spawned = start.stamps.get("agent host spawned")
    ready = start.stamps.get("agent host ready")
    return {
        "started_at": start.started_at.isoformat() if start.started_at else None,
        "app_ready_to_host_ready_ms": start.timings.get("agent host ready"),
        "app_ready_to_static_loaded_ms": start.timings.get("static app url loaded"),
        "spawn_to_heap_flags_ms": gap(spawned, start.heap_flags_at),
        "spawn_to_ready_ms": gap(spawned, ready),
        "heap": start.heap_detail,
        "phases": [{"name": n, "ms": ms, "delta": delta} for n, ms, delta in start.phases],
    }


def pct(values: list[float], q: float) -> float | None:
    clean = sorted(v for v in values if v is not None)
    if not clean:
        return None
    if len(clean) == 1:
        return round(clean[0], 1)
    index = min(len(clean) - 1, max(0, round(q * (len(clean) - 1))))
    return round(clean[index], 1)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="PiForge agent-host 冷启动统计")
    parser.add_argument("--log", type=Path, default=DEFAULT_LOG)
    parser.add_argument("--starts", type=int, default=20, help="只看最近 N 次启动（0 = 全部）")
    parser.add_argument("--json", action="store_true", help="输出 JSON")
    args = parser.parse_args(argv)

    if not args.log.exists():
        print(f"startup_stats: log not found: {args.log}", file=sys.stderr)
        return 2

    starts = collect(args.log, args.starts)
    if not starts:
        print("startup_stats: no 'Startup timing: app ready' entries found", file=sys.stderr)
        return 1

    summaries = [summarize(s) for s in starts]
    ready_values = [s["app_ready_to_host_ready_ms"] for s in summaries]
    report = {
        "log": str(args.log),
        "starts": summaries,
        "p50_app_ready_to_host_ready_ms": pct(ready_values, 0.50),
        "p95_app_ready_to_host_ready_ms": pct(ready_values, 0.95),
        "p50_static_loaded_ms": pct([s["app_ready_to_static_loaded_ms"] for s in summaries], 0.50),
    }

    if args.json:
        print(json.dumps(report, indent=2, ensure_ascii=False))
        return 0

    print(f"log: {args.log}")
    print(f"starts: {len(summaries)}")
    print()
    header = f"{'#':>2} {'app→hostReady':>14} {'spawn→heapFlags':>16} {'app→static':>11} {'spawn→ready':>12}"
    print(header)
    for i, s in enumerate(summaries, 1):
        def show(key: str) -> str:
            value = s[key]
            return f"{value:.0f}" if isinstance(value, (int, float)) else "-"

        print(
            f"{i:>2} {show('app_ready_to_host_ready_ms'):>14} "
            f"{show('spawn_to_heap_flags_ms'):>16} "
            f"{show('app_ready_to_static_loaded_ms'):>11} "
            f"{show('spawn_to_ready_ms'):>12}"
        )
    print()
    print(
        f"p50 app→hostReady = {report['p50_app_ready_to_host_ready_ms']} ms | "
        f"p95 = {report['p95_app_ready_to_host_ready_ms']} ms | "
        f"p50 app→static = {report['p50_static_loaded_ms']} ms"
    )

    phase_names: list[str] = []
    for s in summaries:
        for phase in s["phases"]:
            if phase["name"] not in phase_names:
                phase_names.append(phase["name"])
    if phase_names:
        print()
        print("host 进程内阶段（delta = 距上一阶段，单位 ms）：")
        print(f"{'start':>5} " + " ".join(f"{name:>22}" for name in phase_names))
        for i, s in enumerate(summaries, 1):
            by_name = {p["name"]: p for p in s["phases"]}
            cells = []
            for name in phase_names:
                phase = by_name.get(name)
                cells.append(f"{phase['delta']:>22}" if phase else f"{'-':>22}")
            print(f"{i:>5} " + " ".join(cells))
        if summaries and summaries[-1]["heap"]:
            print()
            print(f"heap (最新一次): {summaries[-1]['heap']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
