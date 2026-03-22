#!/usr/bin/env bash
set -euo pipefail

# Example uploader script.
# Usage: ./uploader-example.sh /absolute/path/to/image.png
# Print the uploaded URL to stdout.

IMG_PATH="$1"

# TODO: Replace this with your real uploader logic.
# For example, call `curl` to upload, then parse JSON and echo the URL.

BASENAME="$(basename "$IMG_PATH")"
echo "https://example-image-bed.invalid/${BASENAME}"
