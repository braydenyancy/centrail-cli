#!/bin/sh
# The plugin's Stop hook. Claude Code started from the Dock, a desktop app
# or an IDE often has a PATH without the Node that nvm, mise, fnm, Volta or
# Homebrew installed, and a bare `node` then fails on every turn. This finds
# one: PATH first, then the Node that last ran centrail in a terminal
# (recorded in its config dir), then the usual install spots. Builtins only,
# so it runs under any PATH; stdin passes through to the CLI untouched.
script="${0%/*}/centrail.mjs"
use() { [ -n "$1" ] && [ -x "$1" ] && exec "$1" "$script" hook stop; }

use "$(command -v node)"
cfg="${CENTRAIL_CONFIG_DIR:-${HOME:-}/.config/centrail}"
if [ -r "$cfg/node" ]; then
  read -r recorded < "$cfg/node"
  use "${recorded:-}"
fi
for n in /opt/homebrew/bin/node /usr/local/bin/node \
  "${HOME:-}/.volta/bin/node" "${HOME:-}/.local/share/mise/shims/node" "${HOME:-}/.asdf/shims/node" \
  "${HOME:-}/.local/share/fnm/aliases/default/bin/node" "${HOME:-}/Library/Application Support/fnm/aliases/default/bin/node"; do
  use "$n"
done
for n in "${NVM_DIR:-${HOME:-}/.nvm}"/versions/node/*/bin/node; do last="$n"; done
use "${last:-}"

echo "centrail: no Node.js found for the Stop hook; run \`npx centrail setup-plugin\` once in a terminal to record yours" >&2
exit 1
