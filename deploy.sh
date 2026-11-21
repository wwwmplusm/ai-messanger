#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
umask 077

if [[ ! -f .env ]]; then
  domain=${1:-}
  chat_id=${2:-}
  if [[ ! "$domain" =~ ^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,}$ ]]; then
    echo "Использование: ./deploy.sh agents.example.org [chat_id]" >&2
    exit 1
  fi
  if [[ -n "$chat_id" && ! "$chat_id" =~ ^-[0-9]+$ ]]; then
    echo "chat_id должен быть отрицательным числом." >&2
    exit 1
  fi
  if ! docker compose version >/dev/null; then
    echo "Установите Docker с Compose." >&2
    exit 1
  fi

  read -rsp 'Токен бота от @BotFather: ' bot_token
  printf '\n'
  if [[ ! "$bot_token" =~ ^[0-9]+:[a-zA-Z0-9_-]+$ ]]; then
    echo "Токен Telegram имеет неверный формат." >&2
    exit 1
  fi
  random_hex() { od -An -N32 -tx1 /dev/urandom | tr -d ' \n'; }
  group_code=$(random_hex)
  runner_one=$(random_hex)
  runner_two=$(random_hex)
  cat > .env <<CONFIG
PUBLIC_URL=https://$domain
TELEGRAM_GROUP_ID=$chat_id
TELEGRAM_BOT_TOKEN=$bot_token
GROUP_SETUP_CODE=$group_code
RUNNER_1_SECRET=$runner_one
RUNNER_2_SECRET=$runner_two
CONFIG
  unset bot_token
fi

docker compose up -d --build
if ! grep -q '^TELEGRAM_GROUP_ID=.' .env; then
  code=$(sed -n 's/^GROUP_SETUP_CODE=//p' .env)
  if [[ -n "$code" ]]; then
    printf 'Администратор Telegram: отправь /bind %s в нужную группу, затем удали сообщение.\n' "$code"
  fi
fi
echo 'Администратор Telegram: ответь /allow на сообщения двух владельцев Codex. Затем каждый открывает /setup в личке бота.'
