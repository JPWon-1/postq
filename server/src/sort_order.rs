//! 트리 순서 계산.
//!
//! 이웃 사이의 값만 잡아 옮긴 한 행만 쓴다. 정수가 바닥나면(1 과 2 사이) 그 목록만 재배번한다.

use std::cmp::Ordering;

/// 새 항목·재배번의 간격. 2의 거듭제곱이라 반으로 쪼개도 정수가 유지된다.
pub const GAP: i64 = 1024;

/// prev 와 next 사이의 값. 자리가 없으면 None — 재배번하라는 신호.
/// 맨 앞에 놓을 때 음수로 내려가는 건 의도다(0 에서 막으면 맨 앞 삽입마다 재배번한다).
pub fn between(prev: Option<i64>, next: Option<i64>) -> Option<i64> {
    match (prev, next) {
        (None, None) => Some(GAP),
        (None, Some(n)) => Some(n - GAP),
        (Some(p), None) => Some(p + GAP),
        // 뒤집혀 들어온 경우도 재배번으로 보낸다 — 중간값이 무의미하다.
        (Some(p), Some(n)) if n - p < 2 => None,
        // Math.floor — 음수에서도 아래로 내린다.
        (Some(p), Some(n)) => Some((p + n).div_euclid(2)),
    }
}

/// GAP 간격으로 다시 매긴 값. 순서는 그대로.
pub fn reindex<T: Clone>(items: &[T]) -> Vec<(T, i64)> {
    items.iter().enumerate().map(|(i, t)| (t.clone(), (i as i64 + 1) * GAP)).collect()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Item {
    pub id: String,
    pub sort_order: i64,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Neighbors {
    pub prev: Option<i64>,
    pub next: Option<i64>,
    pub index: usize,
}

/// moving 을 빼고 beforeId 앞에 끼운 자리의 이웃. 빼는 것이 먼저다 — 안 빼면 '한 칸 아래로' 가 제자리에 머문다.
pub fn neighbors_for(ordered: &[Item], moving_id: &str, before_id: Option<&str>) -> Neighbors {
    let list: Vec<&Item> = ordered.iter().filter(|r| r.id != moving_id).collect();
    // 없는 id 를 받으면(그 사이 삭제됐다) 맨 뒤로 — 거절하는 것보다 낫다.
    let idx = match before_id {
        None => list.len(),
        Some(b) => list.iter().position(|r| r.id == b).unwrap_or(list.len()),
    };
    Neighbors {
        prev: if idx == 0 { None } else { Some(list[idx - 1].sort_order) },
        next: list.get(idx).map(|r| r.sort_order),
        index: idx,
    }
}

/// `a.id.localeCompare(b.id)` 의 근사 — ICU 기본 정렬처럼 대소문자를 먼저 무시하고 비교하고, 같으면 소문자가 앞.
/// id 는 uuid(소문자 16진·하이픈)이거나 'default' 같은 영문이라 이 범위에서는 ICU 와 같다.
/// 문장부호끼리의 순서 같은 ICU 의 세부 규칙은 옮기지 않았다.
pub fn locale_compare(a: &str, b: &str) -> Ordering {
    let fold = |s: &str| s.chars().flat_map(char::to_lowercase).collect::<String>();
    fold(a).cmp(&fold(b)).then_with(|| {
        // 3차 비교: 같은 글자면 소문자가 먼저(ICU 기본).
        for (x, y) in a.chars().zip(b.chars()) {
            if x != y {
                return match (x.is_lowercase(), y.is_lowercase()) {
                    (true, false) => Ordering::Less,
                    (false, true) => Ordering::Greater,
                    _ => x.cmp(&y),
                };
            }
        }
        a.len().cmp(&b.len())
    })
}

/// 목록 정렬 비교자. 서버와 화면이 같은 것을 써야 '2번째 앞' 이 서로 같다 — sortOrder 가 같으면 id 로 못 박는다.
pub fn by_sort_order(a: &Item, b: &Item) -> Ordering {
    a.sort_order.cmp(&b.sort_order).then_with(|| locale_compare(&a.id, &b.id))
}

#[derive(Debug, PartialEq, Eq)]
pub struct Reorder {
    pub updates: Vec<Item>,
    pub reindexed: bool,
}

/// "movingId 를 beforeId 앞으로" 를 실제로 써야 할 행들로. 보통 1건, 자리가 바닥났을 때만 그 목록 전체.
/// siblings 에 movingId 가 없어도 된다 — 다른 폴더에서 옮겨 오는 경우다.
pub fn apply_reorder(siblings: &[Item], moving_id: &str, before_id: Option<&str>) -> Reorder {
    let mut ordered = siblings.to_vec();
    ordered.sort_by(by_sort_order);
    let Neighbors { prev, next, index } = neighbors_for(&ordered, moving_id, before_id);

    // 놓은 자리가 원래 자리면 아무것도 바꾸지 않는다 — 안 한 일을 '순서를 바꿨습니다' 라고 말하지 않게.
    let without: Vec<&str> = ordered.iter().filter(|r| r.id != moving_id).map(|r| r.id.as_str()).collect();
    let mut would_be: Vec<&str> = without[..index].to_vec();
    would_be.push(moving_id);
    would_be.extend_from_slice(&without[index..]);
    let current: Vec<&str> = ordered.iter().map(|r| r.id.as_str()).collect();
    if would_be.join("\u{0}") == current.join("\u{0}") {
        return Reorder { updates: vec![], reindexed: false };
    }

    if let Some(v) = between(prev, next) {
        return Reorder { updates: vec![Item { id: moving_id.to_string(), sort_order: v }], reindexed: false };
    }
    // 자리가 없다. 원하는 순서를 먼저 만들고 목록 전체를 다시 매긴다.
    Reorder {
        updates: reindex(&would_be).into_iter().map(|(id, sort_order)| Item { id: id.to_string(), sort_order }).collect(),
        reindexed: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn it(id: &str, s: i64) -> Item {
        Item { id: id.into(), sort_order: s }
    }
    fn abc() -> Vec<Item> {
        vec![it("a", 1024), it("b", 2048), it("c", 3072)]
    }
    fn nb(prev: Option<i64>, next: Option<i64>, index: usize) -> Neighbors {
        Neighbors { prev, next, index }
    }

    #[test]
    fn between_이웃_사이의_값() {
        assert_eq!(between(None, None), Some(GAP));
        assert_eq!(between(Some(2048), None), Some(2048 + GAP));
        assert_eq!(between(None, Some(1024)), Some(0));
        assert_eq!(between(None, Some(0)), Some(-1024));
        assert_eq!(between(None, Some(-1024)), Some(-2048));
        assert_eq!(between(Some(1024), Some(2048)), Some(1536));
        assert_eq!(between(Some(5), Some(6)), None);
        assert_eq!(between(Some(5), Some(5)), None);
        assert_eq!(between(Some(2048), Some(1024)), None);
        assert_eq!(between(Some(-3), Some(0)), Some(-2)); // Math.floor(-1.5)
    }

    #[test]
    fn 같은_자리에_10번_연속_삽입해도_자리가_남는다() {
        let (prev, mut next) = (0, GAP);
        for i in 0..10 {
            next = between(Some(prev), Some(next)).unwrap_or_else(|| panic!("{}번째 삽입", i + 1));
        }
    }

    #[test]
    fn reindex_는_순서를_두고_다시_매긴다() {
        assert_eq!(reindex(&["a", "b", "c"]), vec![("a", 1024), ("b", 2048), ("c", 3072)]);
        let r = reindex(&["a", "b"]);
        assert_eq!(between(Some(r[0].1), Some(r[1].1)), Some(1536));
    }

    #[test]
    fn neighbors_for_이웃() {
        let l = abc();
        assert_eq!(neighbors_for(&l, "a", None), nb(Some(3072), None, 2));
        assert_eq!(neighbors_for(&l, "c", Some("a")), nb(None, Some(1024), 0));
        assert_eq!(neighbors_for(&l, "a", Some("c")), nb(Some(2048), Some(3072), 1));
        let n = neighbors_for(&l, "a", Some("c"));
        assert_eq!(between(n.prev, n.next), Some(2560));
        assert_eq!(neighbors_for(&l, "a", Some("zzz")), nb(Some(3072), None, 2));
        assert_eq!(neighbors_for(&[it("a", 1024)], "a", None), nb(None, None, 0));
        assert_eq!(neighbors_for(&l, "new", Some("b")), nb(Some(1024), Some(2048), 1));
    }

    #[test]
    fn apply_reorder_실제로_써야_할_행들() {
        let l = abc();
        assert_eq!(apply_reorder(&l, "c", Some("a")), Reorder { updates: vec![it("c", 0)], reindexed: false });
        assert_eq!(apply_reorder(&l, "a", None).updates, vec![it("a", 4096)]);
        assert_eq!(apply_reorder(&l, "new", Some("b")).updates, vec![it("new", 1536)]);
        let tight = vec![it("a", 1), it("b", 2), it("c", 3)];
        assert_eq!(
            apply_reorder(&tight, "c", Some("b")),
            Reorder { updates: vec![it("a", 1024), it("c", 2048), it("b", 3072)], reindexed: true }
        );
        let tight2 = vec![it("a", 1), it("b", 2)];
        assert_eq!(apply_reorder(&tight2, "new", Some("b")).updates.iter().map(|u| u.id.as_str()).collect::<Vec<_>>(), ["a", "new", "b"]);
    }

    #[test]
    fn sort_order_가_같으면_id_로_못_박는다() {
        let mut dup = vec![it("b", 5), it("a", 5)];
        dup.sort_by(by_sort_order);
        assert_eq!(dup.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["a", "b"]);
        // localeCompare 는 대소문자를 먼저 무시한다 — 바이트 순서(B < a)와 다르다.
        assert_eq!(locale_compare("a", "B"), Ordering::Less);
        assert_eq!(locale_compare("a", "A"), Ordering::Less);
    }

    #[test]
    fn 여러_번_옮겨도_순서가_유지된다() {
        let mut rows = abc();
        let mut mv = |id: &str, before: Option<&str>| {
            for u in apply_reorder(&rows, id, before).updates {
                for r in rows.iter_mut().filter(|r| r.id == u.id) {
                    r.sort_order = u.sort_order;
                }
            }
            let mut s = rows.clone();
            s.sort_by(by_sort_order);
            s.into_iter().map(|r| r.id).collect::<Vec<_>>()
        };
        assert_eq!(mv("c", Some("a")), ["c", "a", "b"]);
        assert_eq!(mv("a", None), ["c", "b", "a"]);
        assert_eq!(mv("b", Some("c")), ["b", "c", "a"]);
    }

    #[test]
    fn 제자리에_놓으면_아무것도_바꾸지_않는다() {
        let rows = abc();
        let none = Reorder { updates: vec![], reindexed: false };
        assert_eq!(apply_reorder(&rows, "a", Some("b")), none);
        assert_eq!(apply_reorder(&rows, "b", Some("c")), none);
        assert_eq!(apply_reorder(&rows, "c", None), none);
        assert_eq!(apply_reorder(&rows, "c", Some("a")).updates.len(), 1);
        assert_eq!(apply_reorder(&rows, "a", None).updates.len(), 1);
        let tight = vec![it("a", 1), it("b", 2)];
        assert_eq!(apply_reorder(&tight, "a", Some("b")), none);
    }
}
