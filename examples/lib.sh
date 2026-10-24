# Shared by the examples' run.sh scripts: `hs` runs this checkout's adapter, `$WORK` is a scratch
# directory (a fresh one unless WORK is set), and the stand-in harness binaries are in $BIN.
# Nothing outside $WORK is read or written, except hs's own checkout.
set -eu
EXAMPLES=$(cd "$(dirname "$0")/.." && pwd)
BIN="$EXAMPLES/bin"
# On Node 22, node:sqlite (which the session adapters use) prints an ExperimentalWarning on every
# load; it is noise for these examples, and the example test requires an empty stderr.
hs() { node --disable-warning=ExperimentalWarning "$EXAMPLES/../bin/hs.js" "$@"; }
WORK=${WORK:-$(mktemp -d "${TMPDIR:-/tmp}/hs-example-XXXXXX")}
mkdir -p "$WORK"
# A field of the JSON response on stdin, by a dotted path: `json result.digest`.
# A reader that stops early (`| head`) closes the pipe: that is EPIPE, not an error.
json() { node -e 'process.stdout.on("error",(e)=>{if(e.code!=="EPIPE")throw e;process.exit(0)});let s="";process.stdin.on("data",(c)=>(s+=c)).on("end",()=>{let v=JSON.parse(s);for(const k of process.argv[1].split("."))v=v?.[k];process.stdout.write(v===undefined?"null":typeof v==="string"?v:JSON.stringify(v,null,2));process.stdout.write("\n")})' "$1"; }
