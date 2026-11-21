#!/usr/bin/env bash
set -euo pipefail
dir=/var/lib/ai-messanger-inventory
install -d -m 0755 "$dir"
stage=$(mktemp "$dir/.services.XXXXXX")
trap 'if [[ -e "$stage" ]]; then unlink "$stage"; fi' EXIT
{
  printf 'Обновлено (UTC): %s\n' "$(date -u +'%Y-%m-%d %H:%M:%S')"
  docker ps -a --format '{{.Names}}\t{{.State}}' | LC_ALL=C sort
} > "$stage"
chmod 0644 "$stage"
mv -T -- "$stage" "$dir/services.txt"
