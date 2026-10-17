#!/usr/bin/env bash
# Local end-to-end check of the production path (no Docker): build, run the built server on a temp DB, drive it with curl.
# Usage: scripts/e2e-local.sh [--no-build]
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${E2E_PORT:-8080}"
ORIGIN="http://localhost:$PORT"
TMP="$(mktemp -d)"
PID=""
FAILS=0
cleanup() { [ -n "$PID" ] && kill "$PID" 2>/dev/null && wait "$PID" 2>/dev/null; rm -rf "$TMP"; }
trap cleanup EXIT

pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1${2:+ ($2)}"; FAILS=$((FAILS + 1)); }
check() { # check <label> <jq-bool-expr> <json>
  if [ "$(printf '%s' "$3" | jq -r "$2" 2>/dev/null)" = "true" ]; then pass "$1"; else fail "$1" "$(printf '%s' "$3" | head -c 300)"; fi
}

if [ "${1:-}" != "--no-build" ]; then
  (cd "$ROOT" && npm run build >"$TMP/build-web.log" 2>&1) || { echo "FAIL  web build"; tail -20 "$TMP/build-web.log"; exit 1; }
  (cd "$ROOT/server" && npm run build >"$TMP/build-srv.log" 2>&1) || { echo "FAIL  server build"; tail -20 "$TMP/build-srv.log"; exit 1; }
fi
pass "build web + server"

export SP_DB="$TMP/sp.db" SP_MIGRATIONS="$ROOT/server/migrations"
for who in "create-owner owner 원장" "create-desk desk 인포"; do
  # shellcheck disable=SC2086
  SP_PASSWORD="e2e-password-1" node "$ROOT/server/dist/server/src/cli.js" $who >/dev/null || { echo "FAIL  cli $who"; exit 1; }
done
pass "cli create-owner / create-desk"

if nc -z localhost "$PORT" 2>/dev/null; then
  echo "FAIL  port $PORT is already in use; stop that process or run with E2E_PORT=<free port>"; exit 1
fi
NODE_ENV=production SP_STATIC="$ROOT/dist" SP_MIGRATIONS="$ROOT/server/migrations" SP_ORIGIN="$ORIGIN" PORT="$PORT" \
  node "$ROOT/server/dist/server/src/main.js" >"$TMP/server.log" 2>&1 &
PID=$!
UP=0
for _ in $(seq 1 50); do
  kill -0 "$PID" 2>/dev/null || break
  curl -fs "$ORIGIN/api/healthz" >/dev/null 2>&1 && { UP=1; break; }
  sleep 0.2
done
if [ "$UP" = 1 ] && kill -0 "$PID" 2>/dev/null; then pass "server up (healthz)"; else echo "FAIL  server did not start; log tail:"; tail -20 "$TMP/server.log"; exit 1; fi

# Secure cookies: curl over http will not send them back, so keep the cookie by hand.
login() { # login <id> -> prints "sp_session=..." ; body in $TMP/login.json
  curl -s -D "$TMP/h.txt" -o "$TMP/login.json" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' \
    -d "{\"loginId\":\"$1\",\"password\":\"e2e-password-1\"}" "$ORIGIN/api/auth/login"
  grep -i '^set-cookie: sp_session=' "$TMP/h.txt" | sed -E 's/^[Ss]et-[Cc]ookie: (sp_session=[^;]*).*/\1/' | tr -d '\r'
}
api() { # api <cookie> <METHOD> <path> [json]
  local ck="$1" m="$2" p="$3" b="${4:-}"
  if [ -n "$b" ]; then curl -s -X "$m" -H "Cookie: $ck" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d "$b" "$ORIGIN$p"
  else curl -s -X "$m" -H "Cookie: $ck" -H "Origin: $ORIGIN" "$ORIGIN$p"; fi
}

OWNER="$(login owner)"
[ -n "$OWNER" ] && [ "$(jq -r .me.role "$TMP/login.json")" = OWNER ] && pass "owner login" || { fail "owner login"; exit 1; }
grep -qi '^set-cookie:.*secure' "$TMP/h.txt" && grep -qi '^set-cookie:.*httponly' "$TMP/h.txt" && pass "session cookie is Secure + HttpOnly" || fail "session cookie flags" "$(grep -i set-cookie "$TMP/h.txt")"

PHONE="010-5555-1234"
R="$(api "$OWNER" POST /api/members "{\"name\":\"김하늘\",\"phone\":\"$PHONE\"}")"
MID="$(printf '%s' "$R" | jq -r .id)"
check "create member" '.id != null and .id != "null"' "$R"

R="$(api "$OWNER" POST /api/payments "{\"amount\":180000,\"productName\":\"정규 클래스 8회권\",\"payerName\":\"김하늘\",\"payerPhone\":\"$PHONE\"}")"
check "manual payment 180000 (MANUAL, auto-assigned by phone)" '.source=="MANUAL" and .amount==180000 and .memberId!=null' "$R"

R="$(api "$OWNER" POST "/api/members/$MID/link")"
URL="$(printf '%s' "$R" | jq -r .url)"; TOKEN="${URL##*/m/}"
check "issue member link" '.url|test("/m/.+")' "$R"

pub() { curl -s "$ORIGIN/api/public/m/$TOKEN"; }
P="$(pub)"
check "public page: DEPTH 1, remaining 8, attendCount 0" '.tier.name=="DEPTH 1" and .passes[0].remaining==8 and .attendCount==0' "$P"
if printf '%s' "$P" | grep -Eq '010|5555|180000|amount|price|phone|memo|김하늘'; then fail "public page leaks money/phone/name" "$(printf '%s' "$P" | head -c 300)"; else pass "public page has no money/phone/memo/real name"; fi
check "public name masked" '.name=="김*늘"' "$P"
QR="$(printf '%s' "$P" | jq -r .qr)"
COURSE="$(api "$OWNER" GET /api/bootstrap | jq -r '[.courses[]|select(.kind=="GENERAL")][0].id')"
[ -n "$COURSE" ] && [ "$COURSE" != null ] && pass "found a GENERAL course" || fail "no GENERAL course"

R="$(api "$OWNER" POST /api/attendances "{\"qr\":\"$QR\",\"courseId\":\"$COURSE\"}")"
check "attendance by QR ok, remaining 7" '.ok==true and .remaining==7' "$R"
P="$(pub)"
check "public page: remaining 7, attendCount 1" '.passes[0].remaining==7 and .attendCount==1' "$P"
R="$(api "$OWNER" POST /api/attendances "{\"qr\":\"$QR\",\"courseId\":\"$COURSE\"}")"
check "second scan -> ALREADY" '.ok==false and .reason=="ALREADY"' "$R"
check "remaining still 7 after second scan" '.passes[0].remaining==7 and .attendCount==1' "$(pub)"

DESK="$(login desk)"
[ -n "$DESK" ] && [ "$(jq -r .me.role "$TMP/login.json")" = DESK ] && pass "desk login" || { fail "desk login"; DESK=x; }
B="$(api "$DESK" GET /api/bootstrap)"
check "desk bootstrap loads with data" '(.members|length)>=1 and (.products|length)>=1' "$B"
BAD="$(printf '%s' "$B" | jq -r '[.. | objects | keys[] | select(. == "price" or . == "amount" or . == "ratioInstructor" or . == "perSessionFee")] | unique | join(",")')"
[ -z "$BAD" ] && pass "desk bootstrap has no price/amount/ratioInstructor/perSessionFee keys" || fail "desk bootstrap leaks keys" "$BAD"
CODE="$(curl -s -o /dev/null -w '%{http_code}' -H "Cookie: $DESK" "$ORIGIN/api/settlement?month=$(date +%Y-%m)")"
[ "$CODE" = 403 ] && pass "desk /api/settlement -> 403" || fail "desk /api/settlement" "got $CODE"
CODE="$(curl -s -o /dev/null -w '%{http_code}' -H "Cookie: $OWNER" "$ORIGIN/api/settlement?month=$(date +%Y-%m)")"
[ "$CODE" = 200 ] && pass "owner /api/settlement -> 200" || fail "owner /api/settlement" "got $CODE"

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL PASS"; else echo "$FAILS FAILED"; exit 1; fi
