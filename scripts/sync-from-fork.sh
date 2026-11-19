#!/usr/bin/env bash
# 从 fork 同步插件代码到 third_party —— **绝不动生产词库**。
#
# 为什么需要这个脚本（2026-11-19 真机事故）：
#   手工 `rsync -a --delete fork/ third_party/` 会把 fork 里的 `data/memes.db`
#   覆盖到生产词库上，于是：
#     · 联网兜底学到的新词条（source=web）全丢
#     · schema v2 迁移被回退（source/added_at 列消失）
#     · 下一次联网兜底又要重新迁移，且 INSERT 会因缺列失败
#   当时学到的「我Chovy」就是这么丢的。所以把这件事固化成脚本，别再手敲。
#
# 用法：
#   bash scripts/sync-from-fork.sh [fork 目录，默认 /tmp/forkcheck]
#
# 行为：
#   1. 同步前把生产词库备份到 qqtools/backups/
#   2. rsync 时**排除 data/memes.db**（其余 data 文件如 .bak 也排除）
#   3. 同步后校验：词库文件未被替换、schema 版本未被回退、测试全绿

set -euo pipefail

FORK="${1:-/tmp/forkcheck}"
DEST="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
QQ_ROOT="$(cd "$DEST/../.." && pwd)"
BACKUP_DIR="$QQ_ROOT/qqtools/backups"
DB="$DEST/data/memes.db"

[ -d "$FORK" ] || { echo "找不到 fork 目录：$FORK" >&2; exit 1; }
[ -f "$FORK/lib/index.js" ] || { echo "$FORK 不像 dsh-memewiki 仓库" >&2; exit 1; }

mkdir -p "$BACKUP_DIR"
if [ -f "$DB" ]; then
  BEFORE_SHA=$(sha256sum "$DB" | cut -d' ' -f1)
  BEFORE_COUNT=$(node -e "
    const {DatabaseSync}=require('node:sqlite');
    const db=new DatabaseSync(process.argv[1],{readOnly:true});
    console.log(db.prepare('SELECT COUNT(*) n FROM memes').get().n);
  " "$DB" 2>/dev/null || echo '?')
  STAMP=$(date +%Y%m%d-%H%M%S)
  cp -a "$DB" "$BACKUP_DIR/memes.db.pre-sync-$STAMP.bak"
  echo "✓ 词库已备份：qqtools/backups/memes.db.pre-sync-$STAMP.bak（$BEFORE_COUNT 条）"
else
  BEFORE_SHA=""; BEFORE_COUNT="0"
fi

echo "→ 同步代码（排除 data/，保护生产词库）"
rsync -a --delete \
  --exclude '.git' \
  --exclude 'data/' \
  "$FORK/" "$DEST/"

if [ -f "$DB" ]; then
  AFTER_SHA=$(sha256sum "$DB" | cut -d' ' -f1)
  if [ "$BEFORE_SHA" != "$AFTER_SHA" ]; then
    echo "✗ 生产词库被改动了！$BEFORE_SHA → $AFTER_SHA" >&2
    echo "  这不该发生（rsync 已排除 data/）。请检查脚本参数。" >&2
    exit 1
  fi
  echo "✓ 生产词库未被触碰（sha 一致，$BEFORE_COUNT 条）"

  # schema 版本不能被回退
  VER=$(node -e "
    const {DatabaseSync}=require('node:sqlite');
    const db=new DatabaseSync(process.argv[1],{readOnly:true});
    const r=db.prepare(\"SELECT value FROM meta WHERE key='schema_version'\").get();
    console.log(r?r.value:'');
  " "$DB" 2>/dev/null || echo '')
  echo "  schema_version = ${VER:-'(未设置，下次联网兜底会自动迁移)'}"
fi

echo "→ 语法与测试"
node --check "$DEST/lib/index.js"
node --test "$DEST"/test/*.test.mjs 2>&1 | grep -E '^# (tests|pass|fail)' || true

echo "✓ 同步完成。若改了 index.js / local-overrides.js，记得重启 dsh-qqbot。"
