#!/usr/bin/env bash
#
# Verify a Vigil install published through a Localtonet HTTP/s tunnel.
#
#   scripts/localtonet-verify.sh https://your-subdomain.localto.net
#
# Four questions, in the order that makes a failure readable:
#
#   1. Are the containers up.
#   2. Is Vigil ready from inside the stack.
#   3. Is there a host port publishing Vigil to anything. There must not be.
#   4. Does the public URL answer, over TLS, with Vigil's readiness body.
#
# Two and four are different questions and the whole point of running
# both. Two failing is a Vigil problem. Two passing and four failing is a
# tunnel problem. Four passing and three failing means the public path
# works and you also left a door open on the host, which is the silent
# one nobody notices.
#
# Output is safe to paste. The public hostname is redacted to its
# apex, because it is a routable address for your monitoring system.
# Nothing here reads or prints the AuthToken.
#
# Exit codes: 0 all pass, 1 a check failed, 2 usage/prerequisite.
set -uo pipefail

PUBLIC_URL="${1:-${APP_URL:-}}"
COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.localtonet.yml)
FAILED=0

if [ -z "$PUBLIC_URL" ]; then
  echo "usage: $0 https://your-subdomain.localto.net" >&2
  echo "   (or set APP_URL in the environment)" >&2
  exit 2
fi

# Keep the shape of the hostname, lose the part that identifies it.
# `https://abc123.localto.net/x` becomes `https://<redacted>.localto.net`.
redact() {
  printf '%s' "$1" |
    sed -E 's#^(https?://[^/]+).*#\1#' |
    sed -E 's#^(https?://)[^./]+\.#\1<redacted>.#'
}
REDACTED="$(redact "$PUBLIC_URL")"

ok()   { printf '  PASS  %s\n' "$1"; }
bad()  { printf '  FAIL  %s\n' "$1"; FAILED=1; }
head_() { printf '\n== %s ==\n' "$1"; }

printf 'localtonet verify  %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf 'target             %s\n' "$REDACTED"

# ── 1. containers ────────────────────────────────────────────────────
head_ "1. compose services"
if ! "${COMPOSE[@]}" ps >/dev/null 2>&1; then
  bad "docker compose ps failed. Is Docker running, and are you in the repo root?"
  exit 1
fi
"${COMPOSE[@]}" ps --format 'table {{.Service}}\t{{.Status}}'
for svc in postgres app worker localtonet; do
  state="$("${COMPOSE[@]}" ps --format '{{.Service}} {{.State}}' 2>/dev/null |
    awk -v s="$svc" '$1==s {print $2; exit}')"
  case "$state" in
    running) ok "$svc running" ;;
    "")      bad "$svc is not in this project" ;;
    *)       bad "$svc is $state" ;;
  esac
done

# ── 2. local readiness, from inside ──────────────────────────────────
#
# Through `exec` and not curl on the host, deliberately: the overlay
# publishes no host port, so if curl on the host CAN reach Vigil, that
# is check 3 failing, not check 2 passing.
head_ "2. local readiness (docker compose exec app)"
local_out="$("${COMPOSE[@]}" exec -T app node -e \
  "fetch('http://localhost:3000/api/ready').then(r=>r.text().then(b=>{console.log(r.status+' '+b)})).catch(e=>{console.log('000 '+e.message);process.exitCode=1})" \
  2>&1 | tr -d '\r')"
printf '  %s\n' "$local_out"
case "$local_out" in
  200*ok*) ok "app is ready: Postgres reachable and packaged migrations applied" ;;
  503*)    bad "app is up but not ready (see docs/LOCALTONET.md section 8)" ;;
  *)       bad "no usable answer from /api/ready" ;;
esac

# ── 3. no host port ──────────────────────────────────────────────────
head_ "3. host listeners on 3000"
listeners=""
if command -v ss >/dev/null 2>&1; then
  listeners="$(ss -ltnH 2>/dev/null | awk '{print $4}' | grep -E '(^|[.:])3000$' || true)"
elif command -v netstat >/dev/null 2>&1; then
  listeners="$(netstat -ltn 2>/dev/null | awk '/LISTEN/ {print $4}' | grep -E '(^|[.:])3000$' || true)"
else
  echo "  (no ss or netstat; skipping)"
fi
if [ -z "$listeners" ]; then
  ok "nothing on the host publishes port 3000"
else
  printf '  %s\n' "$listeners"
  case "$listeners" in
    127.0.0.1:*|\[::1\]:*)
      ok "port 3000 is bound to loopback only (a documented variant)" ;;
    *)
      bad "port 3000 is published on a non-loopback address. That is a public Vigil, tunnel or no tunnel." ;;
  esac
fi

# ── 4. public path ───────────────────────────────────────────────────
#
# `localtonet-skip-warning` is not decoration. On a free Localtonet
# account the edge answers every request with its own interstitial
# ("Localtonet Warning ... You are about to navigate to") and a status
# of **200**, and only sends the request on to your service once the
# header is present. Any value does; premium accounts skip the page
# entirely.
#
# Without it this check passes its status-code test and fails its body
# test, which is the right verdict reached for the wrong reason, and it
# is also the single best argument this script makes: a check that
# asserts only "the connection succeeded and the code was 200" reports
# a healthy Vigil while the edge is serving somebody else's HTML.
head_ "4. public https"
bodyfile="$(mktemp)"
metrics="$(curl -sS -m 20 -o "$bodyfile" \
  -H 'localtonet-skip-warning: 1' \
  -w '%{http_code} %{ssl_verify_result} %{time_total} %{http_version}' \
  "${PUBLIC_URL%/}/api/ready" 2>/dev/null || printf '000 - - -')"
read -r code verify total httpver <<EOF
$metrics
EOF
body="$(head -c 200 "$bodyfile" 2>/dev/null || true)"
rm -f "$bodyfile"
printf '  http=%s ssl_verify=%s time=%ss http_version=%s\n' \
  "$code" "$verify" "$total" "$httpver"
printf '  body=%s\n' "$body"
case "$code" in
  200) ok "public URL returns 200" ;;
  000) bad "public URL did not answer. Agent stopped, tunnel stopped, or wrong IP in the tunnel definition." ;;
  *)   bad "public URL returned $code" ;;
esac
# 0 is curl's "certificate verified". Anything else and the chain did not
# check out, which for a *.localto.net host means something is between
# you and the edge.
[ "$verify" = "0" ] && ok "TLS certificate verified by curl" \
  || bad "TLS verification result $verify"
case "$body" in
  *'"status":"ok"'*) ok "the body is Vigil's readiness response, not an edge error page" ;;
  *)                 bad "the public URL answered but the body is not Vigil's" ;;
esac

head_ "result"
if [ "$FAILED" = 0 ]; then echo "  all checks passed"; else echo "  one or more checks failed"; fi
exit "$FAILED"
