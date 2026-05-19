#!/usr/bin/env bash
# SimpleStock data/ 백업 (물리 JSON 파일)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d%H%M%S)"
ARCHIVE="$BACKUP_DIR/simpleStock-data-${STAMP}.tar.gz"
tar czf "$ARCHIVE" -C "$ROOT" data
echo "Backup created: $ARCHIVE"
du -sh "$ARCHIVE"
