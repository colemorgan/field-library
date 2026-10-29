#!/usr/bin/env bash
# Builds the Field Sync fork of CrossPoint for the Xteink X4 Classic (env x4c).
#
#   ./build.sh                      clone (if needed), patch, build
#   CROSSPOINT_DIR=/tmp/cp ./build.sh   use another checkout location
#
# Idempotent: an existing checkout whose field-ble-sync branch already holds the
# patches is built as is. A checkout with uncommitted changes is never touched.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UPSTREAM_URL="${CROSSPOINT_UPSTREAM_URL:-https://github.com/crosspoint-reader/crosspoint-reader}"
CROSSPOINT_DIR="${CROSSPOINT_DIR:-$HERE/crosspoint}"
VENV="${FIELD_SYNC_VENV:-$HERE/.venv}"
BRANCH="field-ble-sync"
ENV_NAME="x4c"
COMMIT="$(tr -d '[:space:]' < "$HERE/UPSTREAM_COMMIT")"

shopt -s nullglob
PATCHES=("$HERE"/patches/*.patch)
shopt -u nullglob
if [[ ${#PATCHES[@]} -eq 0 ]]; then
  echo "No patches in $HERE/patches" >&2
  exit 1
fi

log() { printf '==> %s\n' "$*"; }

# 1. Upstream checkout at the pinned commit.
fresh=0
if [[ ! -d "$CROSSPOINT_DIR/.git" ]]; then
  log "Cloning $UPSTREAM_URL into $CROSSPOINT_DIR"
  git clone --filter=blob:none --no-checkout "$UPSTREAM_URL" "$CROSSPOINT_DIR"
  fresh=1
fi
cd "$CROSSPOINT_DIR"
if ! git cat-file -e "$COMMIT^{commit}" 2>/dev/null; then
  log "Fetching $COMMIT"
  git fetch origin "$COMMIT" || git fetch origin
fi

if [[ $fresh -eq 0 && -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "Refusing to touch $CROSSPOINT_DIR: it has uncommitted changes." >&2
  exit 1
fi

# 2. Patches, unless the branch already carries exactly these patches.
patch_ids() { git patch-id --stable | awk '{print $1}' | sort; }
want="$(cat "${PATCHES[@]}" | patch_ids)"
have=""
if git rev-parse -q --verify "refs/heads/$BRANCH" >/dev/null; then
  have="$(git log -p --reverse "$COMMIT..$BRANCH" | patch_ids)"
fi
if [[ -n "$have" && "$have" == "$want" ]]; then
  log "$BRANCH already has the patches"
  git checkout -q "$BRANCH"
else
  log "Applying ${#PATCHES[@]} patch(es) on $COMMIT"
  git checkout -q --detach "$COMMIT"
  git checkout -q -B "$BRANCH"
  git -c user.name="${GIT_AUTHOR_NAME:-Field Sync build}" -c user.email="${GIT_AUTHOR_EMAIL:-build@localhost}" \
    am --3way --keep-cr "${PATCHES[@]}"
fi
git submodule update --init --recursive

# 3. PlatformIO in a private virtualenv.
if [[ ! -x "$VENV/bin/pio" ]]; then
  log "Creating virtualenv $VENV with PlatformIO"
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install --quiet --upgrade pip
  "$VENV/bin/pip" install --quiet platformio
fi

# 4. Build.
log "Building env $ENV_NAME (the first build downloads toolchains)"
"$VENV/bin/pio" run -e "$ENV_NAME"

BIN="$CROSSPOINT_DIR/.pio/build/$ENV_NAME/firmware.bin"
if [[ ! -f "$BIN" ]]; then
  echo "Build finished but $BIN is missing" >&2
  exit 1
fi
log "Firmware: $BIN"
