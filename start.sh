#!/usr/bin/env bash
# amyluna v2 — 启动所有三个进程
# 用法: bash start.sh
set -e
cd "$(dirname "$0")"

echo "=== amyluna v2 — 三进程启动 ==="

# 强制清理旧进程（多种方式确保干净）
echo "[0/3] 清理旧进程..."
for port in 3101 3102 3103; do
  # 方式1: fuser
  fuser -k "${port}/tcp" 2>/dev/null || true
done
# 方式2: 用 tsx 进程名
pkill -f "tsx src/llmcore/index.ts" 2>/dev/null || true
pkill -f "tsx src/convmgr/index.ts" 2>/dev/null || true
pkill -f "tsx src/receiver/index.ts" 2>/dev/null || true
sleep 1

# 再次确认端口空闲
for port in 3101 3102 3103; do
  if fuser "${port}/tcp" 2>/dev/null; then
    echo "错误: 端口 ${port} 仍被占用，请手动检查"
    exit 1
  fi
done
echo "  所有端口空闲"

# 启动
echo "[1/3] 启动 P3 LLM Core (:3103)..."
npx tsx src/llmcore/index.ts &
P3_PID=$!
sleep 1

echo "[2/3] 启动 P2 ConvMgr (:3102)..."
npx tsx src/convmgr/index.ts &
P2_PID=$!
sleep 1

echo "[3/3] 启动 P1 Receiver (:3101)..."
npx tsx src/receiver/index.ts &
P1_PID=$!

echo ""
echo "=== 已启动 ==="
echo "P3 PID: $P3_PID  (:3103)"
echo "P2 PID: $P2_PID  (:3102)"
echo "P1 PID: $P1_PID  (:3101)"

# 等待就绪
echo ""
for i in $(seq 1 30); do
  ALL_READY=true
  for port in 3101 3102 3103; do
    if ! fuser "${port}/tcp" 2>/dev/null; then
      ALL_READY=false; break
    fi
  done
  if $ALL_READY; then
    echo "所有进程就绪！监听: <GROUP_ID>"
    break
  fi
  sleep 1
done

wait
