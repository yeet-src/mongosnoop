#!/usr/bin/env bash
# Stand up a TLS-enabled MongoDB and drive it, for demoing the encrypted path.
#
#   terminal 1:  yeet run . -- --tls-binary "$(command -v mongosh)"
#   terminal 2:  demo/tls-run.sh
#
# Unlike demo/run.sh (plaintext), this proves the uprobe path: every command it
# generates is invisible to the socket probes.
set -eu

NAME="${MONGOSNOOP_TLS_CONTAINER:-mongo-tls}"
IMAGE="${MONGOSNOOP_DEMO_IMAGE:-mongo:7}"
PORT="${MONGOSNOOP_TLS_PORT:-27018}"
DIR="$(cd "$(dirname "$0")" && pwd)"
CERTS="${MONGOSNOOP_TLS_CERTS:-$DIR/.certs}"

DOCKER="docker"
if ! docker info >/dev/null 2>&1; then DOCKER="sudo docker"; fi

MONGOSH="${MONGOSH:-$(command -v mongosh || true)}"
if [ -z "$MONGOSH" ]; then
	echo "error: mongosh not found. Install it, or set MONGOSH=/path/to/mongosh" >&2
	exit 1
fi

# A self-signed cert is enough for a local demo; Mongo 7 requires a CA file
# alongside it, so the cert doubles as its own CA.
if [ ! -f "$CERTS/mongo.pem" ]; then
	echo "[demo] generating a self-signed cert in $CERTS"
	mkdir -p "$CERTS"
	openssl req -x509 -newkey rsa:2048 -days 365 -nodes \
		-keyout "$CERTS/key.pem" -out "$CERTS/cert.pem" -subj "/CN=localhost" 2>/dev/null
	cat "$CERTS/key.pem" "$CERTS/cert.pem" > "$CERTS/mongo.pem"
fi

if ! $DOCKER ps --format '{{.Names}}' | grep -qx "$NAME"; then
	echo "[demo] starting $IMAGE as $NAME (requireTLS) on :$PORT"
	$DOCKER rm -f "$NAME" >/dev/null 2>&1 || true
	$DOCKER run -d --name "$NAME" -p "$PORT:27017" -v "$CERTS:/certs" "$IMAGE" \
		--tlsMode requireTLS \
		--tlsCertificateKeyFile /certs/mongo.pem \
		--tlsCAFile /certs/cert.pem \
		--tlsAllowConnectionsWithoutCertificates >/dev/null
	printf '[demo] waiting for mongod'
	for _ in $(seq 1 60); do
		if "$MONGOSH" --quiet --tls --tlsCAFile "$CERTS/cert.pem" --tlsAllowInvalidHostnames \
			--host 127.0.0.1 --port "$PORT" --eval 'db.adminCommand({ping:1})' >/dev/null 2>&1; then
			echo " ready"
			break
		fi
		printf '.'
		sleep 1
	done
fi

echo "[demo] driving TLS traffic with $MONGOSH — Ctrl-C to stop"
echo "[demo] point the dashboard at this binary:"
echo "         yeet run . -- --tls-binary $MONGOSH"

trap 'echo; echo "[demo] leaving $NAME running — remove it with: $DOCKER rm -f $NAME"' EXIT INT TERM

while true; do
	"$MONGOSH" --quiet --tls --tlsCAFile "$CERTS/cert.pem" --tlsAllowInvalidHostnames \
		--host 127.0.0.1 --port "$PORT" "$DIR/tls-workload.js" >/dev/null 2>&1 || true
done
