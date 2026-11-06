#!/bin/sh
# postq SQLite 데이터 백업 — 크래시-컨시스턴트 단일 스냅샷을 tar 로 저장.
#
# WAL 모드(journal_mode=WAL)의 라이브 DB 를 postq.db + -wal + -shm 그대로 tar 하면,
# tar 도중 커밋/체크포인트가 일어나 db본체와 -wal 의 시점이 어긋나 복구가 깨질 수 있다.
# 그래서 `postq-server backup` (SQLite `VACUUM INTO`)으로 일관된 단일 파일을 뜬 뒤 그것만 담는다.
#
#   사용:   ./scripts/backup.sh [출력디렉토리]   (기본 ./backups)
#   복구:   컨테이너 정지 → tar 풀기 → 나온 _snap-*.db 를 볼륨의 postq.db 로 교체
#           (VACUUM INTO 산출물이라 -wal/-shm 동반 불필요).
#   cron 예: 0 3 * * *  /path/to/postq/scripts/backup.sh /var/backups/postq
#   다른 compose 파일로 띄웠으면 COMPOSE_FILE=<파일> 을 앞에 붙인다.
#
# compose 파일은 저장소 루트 기준으로 찾는다(cron 처럼 다른 폴더에서 불러도 엉뚱한 compose 프로젝트에
# 붙지 않게). 프로젝트 이름은 compose 파일의 top-level name(postq)이 정한다.
set -e
OUT="${1:-./backups}"
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)   # 아래에서 저장소 루트로 옮겨 가므로 출력 경로를 먼저 절대경로로
cd "$(dirname "$0")/.."
KEEP="${BACKUP_KEEP:-14}"   # 보관 개수(기본 14)
TS=$(date +%Y%m%d-%H%M%S)
FILE="$OUT/postq-data-$TS.tar.gz"
SNAP="/data/_snap-$TS.db"

# 실행 중인 컨테이너 안에서 일관 스냅샷 생성(소스에서 새 파일로 복사) — 서버 실행 파일의 backup 명령(VACUUM INTO).
docker compose exec -T postq postq-server backup "$SNAP"
# 스냅샷만 tar → 호스트 파일로 스트림, 컨테이너의 임시 스냅샷은 제거
docker compose exec -T postq tar czf - -C /data "$(basename "$SNAP")" > "$FILE"
docker compose exec -T postq rm -f "$SNAP"
echo "백업 완료: $FILE ($(du -h "$FILE" | cut -f1))"

# 오래된 백업 정리(최근 KEEP 개만 유지)
ls -1t "$OUT"/postq-data-*.tar.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f
