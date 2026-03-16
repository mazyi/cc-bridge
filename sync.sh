#!/bin/bash

# 配置目标服务器和路径
REMOTE_USER="ma"
REMOTE_HOST="100.64.67.4"
REMOTE_PATH="~/code/cc-bridge"

# 同步 src 目录
rsync -avz --delete \
  --exclude 'node_modules' \
  --exclude '.git' \
  ./src/ \
  "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_PATH}/src/"

echo "同步完成"
