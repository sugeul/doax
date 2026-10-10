#!/usr/bin/env bash
# doax CLI installer — guide at https://doax.io/install
# Usage: curl -fsSL https://doax.io/install.sh | bash
set -euo pipefail

NODE_MIN=20
BASE="${DOAX_BASE:-https://doax.io}"
BIN_DIR="${DOAX_BIN:-$HOME/.local/bin}"
LIB_DIR="${DOAX_LIB:-$HOME/.doax/lib}"

if ! command -v node >/dev/null 2>&1; then
    echo "doax needs Node.js >= ${NODE_MIN}. Install it from https://nodejs.org and re-run." >&2
    exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "${NODE_MAJOR}" -lt "${NODE_MIN}" ]; then
    echo "doax needs Node.js >= ${NODE_MIN}; found $(node -v)." >&2
    exit 1
fi

mkdir -p "${BIN_DIR}" "${LIB_DIR}"
curl -fsSL "${BASE}/cli/doax.mjs" -o "${LIB_DIR}/doax.mjs"

cat > "${BIN_DIR}/doax" <<WRAPPER
#!/usr/bin/env bash
exec node "${LIB_DIR}/doax.mjs" "\$@"
WRAPPER
chmod +x "${BIN_DIR}/doax"

echo "installed $("${BIN_DIR}/doax" --version) -> ${BIN_DIR}/doax"
case ":${PATH}:" in
    *":${BIN_DIR}:"*) ;;
    *)
        echo
        echo "${BIN_DIR} is not on your PATH. Add this to your shell profile:"
        echo "    export PATH=\"${BIN_DIR}:\$PATH\""
        ;;
esac
echo
echo "try:  doax status"
echo "      doax search slack"
