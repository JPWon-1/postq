/// 서버 출력(파이프)을 크기 상한이 있는 로그 파일로 옮겨 적는다 — 줄바꿈 없이 쏟아내도 1MB 씩 돌려 쓴다.
pub fn capture(mut input: impl std::io::Read + Send + 'static, path: std::path::PathBuf) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        use std::io::Write;
        let mut chunk = [0u8; 4096];
        loop {
            let size = match input.read(&mut chunk) { Ok(0) | Err(_) => break, Ok(n) => n };
            // Fixed byte cap, including a producer that never emits a newline.
            if std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) + size as u64 > 1024 * 1024 {
                let _ = std::fs::rename(path.with_extension("log.1"), path.with_extension("log.2"));
                let _ = std::fs::rename(&path, path.with_extension("log.1"));
            }
            let mut options = std::fs::OpenOptions::new();
            options.create(true).append(true);
            #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
            if let Ok(mut file) = options.open(&path) { let _ = file.write_all(&chunk[..size]); }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn logs_are_bounded_even_without_newlines() {
        let dir = std::env::temp_dir().join(format!("postq-log-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("stderr.log");
        capture(std::io::Cursor::new(vec![b'x'; 8 * 1024 * 1024]), path).join().unwrap();
        let files: Vec<_> = std::fs::read_dir(&dir).unwrap().collect();
        assert_eq!(files.len(), 3);
        for entry in files { assert!(entry.unwrap().metadata().unwrap().len() <= 1024 * 1024); }
        std::fs::remove_dir_all(dir).unwrap();
    }
}
