#!/bin/sh
set -eu
wget -q -T 2 -O /dev/null http://127.0.0.1:9333/cluster/status
nc -z -w 2 127.0.0.1 8333
