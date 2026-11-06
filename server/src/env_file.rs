//! `.env` 파일 읽기 — Node 의 `--env-file` 과 같은 규칙.
//!
//! 데스크톱 앱은 예전에 `node --env-file <레거시 .env> --env-file <.env.local> --env-file <앱데이터/app.env> server.js`
//! 로 서버를 띄웠다. 저장된 비밀값(SECRET_ENCRYPTION_KEY 로 암호화한 자격증명)·설정이 그 파일들에 있다 —
//! 서버를 같은 프로세스의 Rust 로 바꾸면서 이 파일을 똑같이 읽지 않으면, 비밀값이 전부 빈 값으로 풀린다.
//!
//! 규칙(Node 22 의 node_dotenv.cc 그대로):
//! - 빈 줄·`#` 으로 시작하는 줄은 건너뛴다. `=` 가 없는 줄도.
//! - 이름 앞의 `export ` 는 뗀다. 이름·값 양끝 공백은 뗀다.
//! - 값이 `"`·`'`·`` ` `` 로 시작하면 같은 따옴표가 닫힐 때까지(여러 줄 가능)가 값이다. 큰따옴표 안의 `\n` 은 줄바꿈.
//! - 따옴표가 없으면 그 줄 끝까지, `#` 뒤는 주석으로 버린다.
//! - 여러 파일을 주면 뒤 파일이 앞 파일을 덮는다. 이미 프로세스 환경에 있는 이름은 파일이 덮지 않는다.

use std::collections::BTreeMap;
use std::path::Path;

/// 한 파일의 내용을 (이름, 값) 목록으로. 같은 이름이 두 번 나오면 뒤의 것이 이긴다(호출부가 맵에 넣는다).
pub fn parse(content: &str) -> Vec<(String, String)> {
    // CRLF 는 LF 로. 짝 없는 CR 은 Node(--env-file)처럼 지운다 — 옛 맥 줄끝을 줄바꿈으로 보지 않고 글자째 버린다(codex 최종 대조).
    let content = content.replace("\r\n", "\n").replace('\r', "");
    let mut out = Vec::new();
    let mut rest = content.as_str();
    while !rest.is_empty() {
        let (line, after) = match rest.find('\n') {
            Some(i) => (&rest[..i], &rest[i + 1..]),
            None => (rest, ""),
        };
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            rest = after;
            continue;
        }
        let Some(eq) = trimmed.find('=') else {
            rest = after;
            continue;
        };
        let mut key = trimmed[..eq].trim();
        if let Some(k) = key.strip_prefix("export ") {
            key = k.trim();
        }
        // 값은 원래 줄에서 다시 잡는다 — 따옴표 값은 다음 줄로 이어질 수 있다.
        let line_start = line.len() - line.trim_start().len();
        let tail = &rest[line_start + eq + 1..];
        let tail_trimmed = tail.trim_start_matches([' ', '\t']);
        let quote = tail_trimmed.chars().next().filter(|c| matches!(c, '"' | '\'' | '`'));
        if let Some(q) = quote {
            if let Some(close) = tail_trimmed[1..].find(q) {
                let mut value = tail_trimmed[1..1 + close].to_string();
                if q == '"' {
                    value = value.replace("\\n", "\n");
                }
                out.push((key.to_string(), value));
                // 닫는 따옴표 뒤, 그 줄의 끝까지 건너뛴다.
                let consumed = &tail_trimmed[1 + close + 1..];
                rest = consumed.find('\n').map_or("", |i| &consumed[i + 1..]);
                continue;
            }
        }
        // 따옴표 없는 값(또는 닫히지 않은 따옴표) — 이 줄 끝까지, # 뒤는 주석.
        let value_line = &trimmed[eq + 1..];
        let value = value_line.split('#').next().unwrap_or("").trim();
        out.push((key.to_string(), value.to_string()));
        rest = after;
    }
    out
}

/// 파일들을 순서대로 읽어 합친다 — 뒤 파일이 이긴다. 없는 파일은 건너뛴다(Node 는 없으면 실패하지만, 앱은
/// 있는 파일만 골라 넘겼다). 못 읽는 파일은 오류로 돌려준다 — 조용히 넘기면 비밀값이 빈 값으로 풀린다.
pub fn load(files: &[&Path]) -> std::io::Result<BTreeMap<String, String>> {
    let mut merged = BTreeMap::new();
    for file in files {
        if !file.exists() {
            continue;
        }
        let content = std::fs::read_to_string(file)?;
        for (k, v) in parse(&content) {
            merged.insert(k, v);
        }
    }
    Ok(merged)
}

/// 합친 값을 프로세스 환경에 넣는다 — 이미 있는 이름은 건드리지 않는다(Node: 환경이 파일보다 먼저다).
/// 넣은 이름 목록을 돌려준다(값은 비밀일 수 있어 돌려주지 않는다).
pub fn apply(merged: &BTreeMap<String, String>) -> Vec<String> {
    let mut set = Vec::new();
    for (k, v) in merged {
        if k.is_empty() || k.contains('=') || k.contains('\0') || v.contains('\0') {
            continue;
        }
        if std::env::var_os(k).is_none() {
            std::env::set_var(k, v);
            set.push(k.clone());
        }
    }
    set
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 짝_없는_cr_은_node_처럼_지운다() {
        // node --env-file 실측: PARITY_X=a\rPARITY_Y=b\r → PARITY_X="aPARITY_Y=b"
        assert_eq!(parse("PARITY_X=a\rPARITY_Y=b\r"), vec![("PARITY_X".to_string(), "aPARITY_Y=b".to_string())]);
        assert_eq!(parse("A=1\r\nB=2\r\n"), vec![("A".to_string(), "1".to_string()), ("B".to_string(), "2".to_string())]);
    }

    fn map(s: &str) -> BTreeMap<String, String> {
        parse(s).into_iter().collect()
    }

    #[test]
    fn node_의_env_file_규칙대로_읽는다() {
        let m = map(concat!(
            "# 주석\n",
            "\n",
            "A=1\n",
            "  B = two words  \n",
            "export C=exported\n",
            "D=value # 주석은 버린다\n",
            "E=\"double \\n quoted # 주석 아님\"\n",
            "F='single \\n raw'\n",
            "G=`back`\n",
            "H=\"multi\n",
            "line\"\n",
            "I=\n",
            "noequals\n",
            "J=a=b=c\r\n",
            "K=\"unclosed\n",
            "L=last",
        ));
        assert_eq!(m["A"], "1");
        assert_eq!(m["B"], "two words");
        assert_eq!(m["C"], "exported");
        assert_eq!(m["D"], "value");
        assert_eq!(m["E"], "double \n quoted # 주석 아님");
        assert_eq!(m["F"], "single \\n raw");
        assert_eq!(m["G"], "back");
        assert_eq!(m["H"], "multi\nline");
        assert_eq!(m["I"], "");
        assert!(!m.contains_key("noequals"));
        assert_eq!(m["J"], "a=b=c");
        assert_eq!(m["K"], "\"unclosed");
        assert_eq!(m["L"], "last");
    }

    #[test]
    fn 뒤_파일이_앞_파일을_덮고_없는_파일은_건너뛴다() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join(".env");
        let b = dir.path().join(".env.local");
        std::fs::write(&a, "X=from-env\nY=only-env\n").unwrap();
        std::fs::write(&b, "X=from-local\n").unwrap();
        let missing = dir.path().join("app.env");
        let m = load(&[&a, &b, &missing]).unwrap();
        assert_eq!(m["X"], "from-local");
        assert_eq!(m["Y"], "only-env");
    }

    #[test]
    fn 이미_있는_환경_변수는_덮지_않는다() {
        let key = format!("POSTQ_ENV_FILE_TEST_{}", std::process::id());
        std::env::set_var(&key, "from-process");
        let fresh = format!("{key}_FRESH");
        let m: BTreeMap<String, String> = [(key.clone(), "from-file".into()), (fresh.clone(), "v".into())].into();
        let set = apply(&m);
        assert_eq!(std::env::var(&key).unwrap(), "from-process");
        assert_eq!(std::env::var(&fresh).unwrap(), "v");
        assert_eq!(set, vec![fresh.clone()]);
        std::env::remove_var(&key);
        std::env::remove_var(&fresh);
    }
}
