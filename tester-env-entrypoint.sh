#!/bin/bash
# tester-env entrypoint for CryptPad: generate config, skip OnlyOffice, build, run.
# CPAD_MAIN_ORIGIN / CPAD_MAIN_PORT / CPAD_SANDBOX_PORT / CPAD_WS_PORT are
# injected by the CLI.
set -e
CPAD_HOME="/cryptpad"
CONF="${CPAD_CONF:-$CPAD_HOME/config/config.js}"
export CRYPTPAD_CONFIG="$CONF"
MAIN_PORT="${CPAD_MAIN_PORT:-3000}"
SANDBOX_PORT="${CPAD_SANDBOX_PORT:-3001}"
WS_PORT="${CPAD_WS_PORT:-3003}"
MAIN_ORIGIN="${CPAD_MAIN_ORIGIN:-http://host.docker.internal:${MAIN_PORT}}"

cp "$CPAD_HOME/config/config.example.js" "$CONF"
# The tester's browser runs in a container, so it reaches us through
# TESTER_ENV_BROWSER_ORIGIN (bridge gateway) or host.docker.internal, never
# localhost. CryptPad gates app paths client-side
# (www/common/sframe-common-outer.js: window.location.origin !==
# ApiConfig.httpUnsafeOrigin -> "only be accessed via" modal + stuck Loading,
# plus Origin-header CORS checks in lib/http-worker.js). Pinning httpUnsafeOrigin
# to that origin makes the browser vantage pass the check. httpSafeOrigin stays
# unset so lib/env.js derives it as unsafe-origin port+1 (== CPAD_SANDBOX_PORT).
# Host-side curl to localhost still works: no server-side Host-header gate.
sed -i "s@httpUnsafeOrigin: 'http://localhost:3000'@httpUnsafeOrigin: '${MAIN_ORIGIN}'@" "$CONF"
sed -i "s@//httpAddress: 'localhost'@httpAddress: '0.0.0.0'@" "$CONF"
sed -i "s@//httpPort: 3000@httpPort: ${MAIN_PORT}@" "$CONF"
# NOTE: httpSafePort is intentionally left at its commented default.
# Upstream lib/env.js only assigns Env.httpSafePort on the default path
# (typeof(config.httpSafePort) !== 'number' -> httpPort+1); setting it
# explicitly leaves Env.httpSafePort undefined, so the sandbox listener
# never starts and /api/config advertises the main origin as sandbox.
# Our sandbox is always MAIN+1, exactly the upstream default.
sed -i "s@// websocketPort: 3003@websocketPort: ${WS_PORT}@" "$CONF"
sed -i "s@installMethod: 'unspecified'@installMethod: 'docker'@" "$CONF"

cd "$CPAD_HOME"
# Never install OnlyOffice in tester-env runs (slow, unneeded for non-Office apps).
npm run build
exec "$@"
