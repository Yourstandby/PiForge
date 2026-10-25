#!/usr/bin/env bash
# PiForge codemode 热修复（macOS / Linux）
# 用法： ./hotfix-codemode.sh [PiForge.app 路径]
set -euo pipefail

APP=${1:-/Applications/PiForge.app}
WORKER_NAME='codemode-worker.js'

RES=''
for cand in "$APP/resources" "$APP/Contents/Resources"; do
  if [ -d "$cand/standalone" ]; then RES="$cand"; break; fi
done
if [ -z "$RES" ]; then
  echo "[hotfix] 没找到 standalone 目录，请把 PiForge.app 路径作为参数传入" >&2
  exit 1
fi

HOST_DIR="$RES/standalone/agent-host"
PI_PKG="$RES/standalone/node_modules/@earendil-works/pi-coding-agent"
if [ ! -d "$HOST_DIR" ]; then echo "[hotfix] 缺少 $HOST_DIR" >&2; exit 1; fi

SRC=''
if [ -d "$PI_PKG" ]; then SRC="$(find "$PI_PKG" -type f -name "$WORKER_NAME" | head -n 1 || true)"; fi
if [ -z "$SRC" ]; then
  echo "[hotfix] 安装里找不到 $WORKER_NAME（可能已是修复版）"
  exit 0
fi

queue=("$SRC")
declare -A seen=()
files=()
while [ ${#queue[@]} -gt 0 ]; do
  cur="${queue[0]}"; queue=("${queue[@]:1}")
  [ -n "${seen[$cur]:-}" ] && continue
  seen["$cur"]=1
  [ -f "$cur" ] || continue
  files+=("$cur")
  dir="$(dirname "$cur")"
  while IFS= read -r rel; do
    [ -z "$rel" ] && continue
    for cand in "$dir/$rel" "$dir/$rel.js" "$dir/$rel.mjs" "$dir/$rel/index.js"; do
      if [ -f "$cand" ]; then queue+=("$cand"); break; fi
    done
  done < <(grep -oE "(from|import\(|new URL\()[[:space:]]*['\"]\.[^'\"]+['\"]" "$cur" 2>/dev/null \
           | sed -E "s/.*['\"]([^'\"]+)['\"]$/\1/" || true)
done

for f in "${files[@]}"; do cp -f "$f" "$HOST_DIR/"; done

if [ ! -f "$HOST_DIR/$WORKER_NAME" ]; then echo "[hotfix] 复制后仍缺少 $WORKER_NAME" >&2; exit 1; fi
echo "[hotfix] OK  ${#files[@]} 个文件 -> agent-host/"
echo "[hotfix] 完成。重新发起一次带工具调用的会话即可验证；重装/自动更新会覆盖本补丁。"
