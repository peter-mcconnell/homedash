#!/usr/bin/env bash
# Build (and optionally install) the homedash Tizen TV app.
#   ./build.sh [dashboard-url] [--install <tv-ip>] [--profile <security-profile>]
# The dashboard URL defaults to [tv] dashboard_url in ../config.toml. Needs Tizen Studio's CLI
# (~/tizen-studio/tools/ide/bin/tizen) and a security profile (see README: "TV app").
set -euo pipefail
cd "$(dirname "$0")"
URL="" TV="" PROFILE="${TIZEN_PROFILE:-homedash}"
while [ $# -gt 0 ]; do
  case "$1" in
    --install) TV="$2"; shift 2 ;;
    --profile) PROFILE="$2"; shift 2 ;;
    *) URL="$1"; shift ;;
  esac
done
if [ -z "$URL" ]; then
  URL=$(python3 -c 'import tomllib; print(tomllib.load(open("../config.toml","rb"))["tv"]["dashboard_url"])' 2>/dev/null || true)
fi
[ -n "$URL" ] || { echo "usage: $0 <dashboard-url e.g. http://192.168.1.10:8090/> [--install <tv-ip>]"; exit 2; }
URL="${URL%/}/"
ORIGIN=$(python3 -c 'import sys,urllib.parse as u; p=u.urlparse(sys.argv[1]); print(f"{p.scheme}://{p.netloc}")' "$URL")
TIZEN="${TIZEN:-$HOME/tizen-studio/tools/ide/bin/tizen}"
B=build; rm -rf "$B"; mkdir -p "$B"
for f in config.xml index.html shell.css shell.js icon.png; do
  sed -e "s#{{DASHBOARD_URL}}#$URL#g" -e "s#{{DASHBOARD_ORIGIN}}#$ORIGIN#g" "$f" > "$B/$f"
done
(cd "$B" && "$TIZEN" package -t wgt -s "$PROFILE" -- "$PWD" >/dev/null && mv ./*.wgt HomeDash.wgt)
echo "built $B/HomeDash.wgt for $URL"
if [ -n "$TV" ]; then
  SDB="${SDB:-$HOME/tizen-studio/tools/sdb}"
  "$SDB" connect "$TV" >/dev/null
  "$TIZEN" install -n HomeDash.wgt -s "$TV:26101" -- "$PWD/$B" | grep -E "successfully|Failed"
  "$SDB" -s "$TV:26101" shell 0 was_execute HmDash0001.HomeDash | head -1
fi
