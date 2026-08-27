#!/usr/bin/env bash
# Spawn MongoDB traffic for the mongosnoop TUI.
#
#   terminal 1:  yeet run .        # the dashboard
#   terminal 2:  demo/run.sh       # this — starts MongoDB and generates traffic
#
# Starts a throwaway MongoDB container (if one isn't already up) and drives it
# with mongosh from inside that container, so nothing needs installing on the
# host beyond docker.
set -eu

NAME="${MONGOSNOOP_DEMO_CONTAINER:-mongosnoop-demo}"
IMAGE="${MONGOSNOOP_DEMO_IMAGE:-mongo:7}"
DIR="$(cd "$(dirname "$0")" && pwd)"

DOCKER="docker"
if ! docker info >/dev/null 2>&1; then DOCKER="sudo docker"; fi

if ! $DOCKER ps --format '{{.Names}}' | grep -qx "$NAME"; then
	echo "[demo] starting $IMAGE as $NAME"
	$DOCKER rm -f "$NAME" >/dev/null 2>&1 || true
	$DOCKER run -d --name "$NAME" -p 27017:27017 "$IMAGE" >/dev/null
	printf '[demo] waiting for mongod'
	for _ in $(seq 1 60); do
		if $DOCKER exec "$NAME" mongosh --quiet --eval 'db.adminCommand({ping:1})' >/dev/null 2>&1; then
			echo " ready"
			break
		fi
		printf '.'
		sleep 1
	done
fi

trap 'echo; echo "[demo] leaving $NAME running — remove it with: $DOCKER rm -f $NAME"' EXIT INT TERM

$DOCKER cp "$DIR/workload.js" "$NAME:/tmp/workload.js"
exec $DOCKER exec "$NAME" mongosh --quiet /tmp/workload.js
