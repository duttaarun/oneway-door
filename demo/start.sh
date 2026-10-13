#!/bin/sh
# Starts the One-Way Door demo Control Centre and opens it in your browser. Needs Java 21+ and git. No Docker.
# Usage: demo/start.sh                       the UI at http://localhost:7070
#        demo/start.sh --owd.run=incident    headless: incident | matrix | prepare (exit 0 = as expected)
set -e
here="$(cd "$(dirname "$0")" && pwd)"
jar="$here/control-centre/target/control-centre.jar"
if [ ! -f "$jar" ] || [ -n "$(find "$here/control-centre/src" "$here/control-centre/pom.xml" -newer "$jar" -print 2>/dev/null | head -1)" ]; then
  echo "Building the Control Centre (the first build downloads dependencies and takes a few minutes)…"
  (cd "$here/control-centre" && sh ./mvnw -B -q package -DskipTests)
fi
cd "$here/.."
exec "${JAVA_HOME:+$JAVA_HOME/bin/}java" -jar "$jar" "$@"
