#!/bin/sh
# Rebuilds demo/branches.bundle: main and the six demo branches, with history, in one file that travels in a zip.
# Run it after changing a demo branch, then commit the bundle. Changes to main alone don't need it: restoring
# commits whatever the zip has beyond the bundled main.
set -e
cd "$(dirname "$0")/.."
git bundle create demo/branches.bundle main pr-482-minor-units split/1-expand split/2-migrate split/3-contract split/4-drop
git bundle verify -q demo/branches.bundle
ls -lh demo/branches.bundle
