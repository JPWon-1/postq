//! 사용자용 명령 `postq` — `npm install -g postq`·`brew install` 로 깔린다. 내용은 [`postq_server::cli`].
//! 도커·E2E·개발·데스크톱이 쓰는 `postq-server`(환경 변수 설정)는 그대로 따로 있다.

fn main() {
    std::process::exit(postq_server::cli::main());
}
