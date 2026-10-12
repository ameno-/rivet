#!/usr/bin/env bash
# Deploy the standalone Pi Mate to a k3s cluster.
#
#   ./deploy/deploy.sh [--host agent-core]
#
# What it does:
#
#   1. Builds both images (delegates to deploy/build.sh).
#   2. Imports them into the target cluster's containerd over SSH
#      (`docker save | k3s ctr images import -`), so no registry is needed.
#   3. Creates the pi-mate-env Secret: a freshly generated Engine admin token
#      and the model gateway key, copied from an existing cluster Secret so
#      the value never transits this repository or a log.
#   4. Applies deploy/k8s/pi-mate.yaml and waits for readiness.
#
# Idempotent: re-running updates images, re-applies the manifest, and leaves
# the existing Secret alone (pass --rotate-token to regenerate the token).
set -euo pipefail

cd "$(dirname "$0")/.."
EXAMPLE_ROOT="$(pwd)"

HOST="${PI_MATE_DEPLOY_HOST:-agent-core}"
NAMESPACE="pi-mate"
GATEWAY_KEY_SOURCE_SECRET="${GATEWAY_KEY_SOURCE_SECRET:-centaur-infra-env}"
GATEWAY_KEY_SOURCE_NAMESPACE="${GATEWAY_KEY_SOURCE_NAMESPACE:-centaur}"
GATEWAY_KEY_SOURCE_KEY="${GATEWAY_KEY_SOURCE_KEY:-LITELLM_GATEWAY_API_KEY}"
ROTATE_TOKEN=0

for arg in "$@"; do
	case "$arg" in
		--host) HOST="${2:-}" ;;
		--host=*) HOST="${arg#*=}" ;;
		--rotate-token) ROTATE_TOKEN=1 ;;
		*) echo "unknown flag: $arg" >&2; exit 2 ;;
	esac
	shift || true
done

SSH=(ssh -o BatchMode=yes "$HOST")

echo "== building images =="
"$EXAMPLE_ROOT/deploy/build.sh"

echo "== importing images into k3s on ${HOST} =="
for image in pi-mate-engine pi-mate-runtime; do
	echo "  importing ${image}:latest"
	docker save "${image}:latest" | "${SSH[@]}" "sudo k3s ctr images import - >/dev/null"
done

echo "== creating the ${NAMESPACE} namespace and Secret =="
"${SSH[@]}" "kubectl create namespace ${NAMESPACE} --dry-run=client -o yaml | kubectl apply -f - >/dev/null"

if [ "$ROTATE_TOKEN" = "1" ] || ! "${SSH[@]}" "kubectl -n ${NAMESPACE} get secret pi-mate-env >/dev/null 2>&1"; then
	echo "  generating a new Engine admin token and copying the gateway key"
	TOKEN="$(openssl rand -hex 24)"
	# The gateway key is copied cluster-side (secret to secret) so the value
	# never leaves the cluster or appears in this script's output.
	"${SSH[@]}" "kubectl -n ${GATEWAY_KEY_SOURCE_NAMESPACE} get secret ${GATEWAY_KEY_SOURCE_SECRET} -o jsonpath='{.data.${GATEWAY_KEY_SOURCE_KEY}}' \
		| { read -r B64; kubectl -n ${NAMESPACE} create secret generic pi-mate-env \
			--from-literal=RIVET_TOKEN='${TOKEN}' \
			--from-literal=LITELLM_GATEWAY_API_KEY=\"\$(printf %s \"\$B64\" | base64 -d)\" \
			--dry-run=client -o yaml | kubectl apply -f -; }"
else
	echo "  existing pi-mate-env Secret left unchanged (use --rotate-token to regenerate)"
fi

echo "== applying the manifest =="
scp -q -o BatchMode=yes "$EXAMPLE_ROOT/deploy/k8s/pi-mate.yaml" "$HOST:/tmp/pi-mate.yaml"
"${SSH[@]}" "kubectl apply -f /tmp/pi-mate.yaml && rm -f /tmp/pi-mate.yaml"

echo "== waiting for readiness =="
"${SSH[@]}" "kubectl -n ${NAMESPACE} rollout status statefulset/pi-mate-engine --timeout=180s"
"${SSH[@]}" "kubectl -n ${NAMESPACE} rollout status deployment/pi-mate-runtime --timeout=180s"
"${SSH[@]}" "kubectl -n ${NAMESPACE} get pods -o wide"

echo "== deployed. Mate endpoint inside the cluster =="
echo "   engine:  http://pi-mate-engine.${NAMESPACE}.svc.cluster.local:6420"
echo "   runtime: http://pi-mate-runtime.${NAMESPACE}.svc.cluster.local:6423"
