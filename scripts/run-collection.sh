#!/bin/sh
# 한 번 실행한 결과에서 JSON 요약과 JUnit을 함께 얻는다.
exec node "$(dirname "$0")/run-collection.mjs" "$@"
