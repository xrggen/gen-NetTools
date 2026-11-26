#!/usr/bin/env bash
set -euo pipefail

source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
node_dir=/opt/gen-nettools-ota
runtime_dir=/etc/gen-nettools-ota
image=gen-nettools-ota:0.1.1
gateway=gen-screenshare-public-gateway-1
container=gen-nettools-ota-screenshare
preview=false
if [[ ${1:-} == --preview ]]; then
  preview=true
  container=gen-nettools-ota-screenshare-preview
elif [[ $# != 0 ]]; then
  exit 2
fi
lease=$(openssl rand -hex 32)
reader_pid=
ota_pid=

reader_control() {
  printf 'header = "Authorization: Bearer %s"\n' "$lease" |
    curl --silent --show-error --fail --max-time 2 --output /dev/null --noproxy '*' --request POST \
      --config - "http://127.0.0.1:48123/$1"
}

stop() {
  trap - EXIT
  if [[ -n $ota_pid ]]; then
    docker stop --time 8 "$container" >/dev/null 2>&1 || true
  fi
  if [[ -n $reader_pid ]]; then
    reader_control stop 2>/dev/null || true
  fi
}
trap stop EXIT
trap 'exit 0' TERM INT

if docker container inspect "$container" >/dev/null 2>&1; then
  printf 'Managed OTA container already exists\n' >&2
  exit 1
fi
printf '{"port":48123,"lease":"%s"}\n' "$lease" |
  docker exec -i "$gateway" node --input-type=module -e "$(cat -- "$source_dir/screenshare-reader.mjs")" \
    gen-nettools-screenshare-reader &
reader_pid=$!

ready=false
for (( attempt = 0; attempt < 10; attempt++ )); do
  if reader_control renew 2>/dev/null; then
    ready=true
    break
  fi
  kill -0 "$reader_pid" 2>/dev/null || break
  sleep 1
done
if [[ $ready != true ]]; then
  printf 'GitCode Release reader did not start\n' >&2
  exit 1
fi
printf '{"lease":"%s","preview":%s}\n' "$lease" "$preview" |
  docker run --rm --init -i --name "$container" --network host --read-only --cap-drop ALL \
    --security-opt no-new-privileges \
    --env "NETTOOLS_OTA_MINIMUM_CLIENT_VERSION=${NETTOOLS_OTA_MINIMUM_CLIENT_VERSION:-}" \
    --mount "type=bind,source=$runtime_dir,target=/run/gen-nettools-ota,readonly" \
    --mount "type=bind,source=$source_dir/server.mjs,target=$node_dir/server.mjs,readonly" \
    --mount "type=bind,source=$source_dir/screenshare-server.mjs,target=$node_dir/screenshare-server.mjs,readonly" \
    "$image" node screenshare-server.mjs &
ota_pid=$!

while kill -0 "$ota_pid" 2>/dev/null && kill -0 "$reader_pid" 2>/dev/null; do
  sleep 5 &
  wait "$!"
  reader_control renew
done
exit 1
