"""
双引擎搜索 — SQL 引擎（LIKE 子串匹配）+ AI 语义搜索的候选组装
技术决策：不用 FTS5（unicode61 分词把整段中文当一个 token，中文搜索残废）；
用户历史量级小（人均几十条），owner 过滤后 Python 内存匹配毫秒级。
"""
import re

from sqlalchemy import select

from database import async_session
from history_store import TaskRecord

# 搜索列：标题 / 字幕全文 / 概要 / MD 笔记（四列任一命中即算该 term 命中）
_SEARCH_COLS = ("title", "raw_text", "summary_content", "md_content")

# 切词：空白 + 中英文标点为分隔；中文连续段整段作一个 term
_SPLIT_RE = re.compile('[\\s，。！？、；：\u201c\u201d\u2018\u2019（）《》〈〉【】…—·～,.!?;:"\'()\\[\\]<>~\\-/\\\\|@#$%^&*+=`]+')
# 停用单字（单字 term 噪声太大，直接丢弃）
_STOP_SINGLE = set("的了我在你他她它这那有没不都也很和就是啊吗呢吧哦哈嘛")


def extract_terms(query: str) -> list[str]:
    """query → 关键词列表（中文整段一个 term；过滤单字符与停用单字；
    中文段两端剥离停用字——"我的珠峰"→"珠峰"，避免自然表达整段不命中）"""
    terms = []
    for t in _SPLIT_RE.split(query or ""):
        t = t.strip()
        if not t:
            continue
        # 中文段两端剥离停用字（中间的保留："喜马拉雅"不动）
        while len(t) > 1 and t[0] in _STOP_SINGLE:
            t = t[1:]
        while len(t) > 1 and t[-1] in _STOP_SINGLE:
            t = t[:-1]
        if len(t) < 2:
            continue
        terms.append(t)
    # 去重保序
    seen, out = set(), []
    for t in terms:
        if t not in seen:
            seen.add(t)
            out.append(t)
    return out


def _hit_positions(row: dict, term: str) -> tuple[str, int] | None:
    """term 在四列中的首个命中（列名, 字符位置）；未命中返回 None
    大小写不敏感（deepseek 也能命中 DeepSeek）；lower 不改变字符数，位置与原串一致"""
    needle = term.lower()
    for col in _SEARCH_COLS:
        text = row.get(col) or ""
        pos = text.lower().find(needle)
        if pos >= 0:
            return col, pos
    return None


def _context(text: str, pos: int, radius: int) -> str:
    """命中位置 ±radius 字上下文窗（去换行，两端加省略号）"""
    start = max(0, pos - radius)
    end = min(len(text), pos + radius)
    snippet = text[start:end].replace("\n", " ").strip()
    return ("…" if start > 0 else "") + snippet + ("…" if end < len(text) else "")


def _match_row(row: dict, terms: list[str]) -> tuple[int, str] | None:
    """AND 语义：所有 term 都命中才返回 (命中term数, 首个命中的snippet)；否则 None"""
    first_snippet = ""
    for term in terms:
        hit = _hit_positions(row, term)
        if not hit:
            return None
        if not first_snippet:
            col, pos = hit
            first_snippet = _context(row[col], pos, 20)
    return len(terms), first_snippet


async def load_owner_rows(uid: int) -> list[dict]:
    """该用户全部历史记录（搜索列 + 展示列）；量级小（人均几十条），内存匹配。
    调用约定：一次请求只加载一遍，rows 参数向下传递全程复用。"""
    async with async_session() as session:
        rows = (await session.execute(
            select(
                TaskRecord.task_id, TaskRecord.title, TaskRecord.source_platform,
                TaskRecord.created_at, TaskRecord.raw_text,
                TaskRecord.summary_content, TaskRecord.md_content,
            ).where(TaskRecord.owner_uid == uid)
            .order_by(TaskRecord.created_at.desc())
        )).all()
    return [
        {
            "task_id": r[0], "title": r[1], "source_platform": r[2],
            "created_at": r[3].isoformat() if r[3] else None,
            "raw_text": r[4], "summary_content": r[5], "md_content": r[6],
        }
        for r in rows
    ]


async def sql_search(uid: int, query: str, rows: list[dict] | None = None) -> list[dict]:
    """SQL 引擎：owner 范围内四列子串 AND 匹配，标题命中优先，上限 20 条
    rows：调用方已加载的 owner 行（AI 搜索链路复用，免二次全量拉取）"""
    terms = extract_terms(query)
    if not terms:
        return []
    if rows is None:
        rows = await load_owner_rows(uid)
    results = []
    for row in rows:
        m = _match_row(row, terms)
        if not m:
            continue
        _, snippet = m
        title_hit = any(t in (row["title"] or "") for t in terms)
        results.append({
            "task_id": row["task_id"],
            "title": row["title"],
            "source_platform": row["source_platform"],
            "created_at": row["created_at"],
            "snippet": snippet,
            "matched": terms,
            "_title_hit": title_hit,
        })
    # 标题命中优先，其余按时间倒序（_load 已按时间倒序）
    results.sort(key=lambda r: (not r["_title_hit"]))
    for r in results:
        r.pop("_title_hit", None)
    return results[:20]


def slim_card(row: dict, query: str) -> str:
    """AI 精排用瘦卡片：有命中 → 标题 + 命中上下文窗(±40 字)；无命中 → 标题 + 开头 80 字"""
    title = row["title"] or "未知视频"
    terms = extract_terms(query)
    for term in terms:
        hit = _hit_positions(row, term)
        if hit:
            col, pos = hit
            return f"《{title}》 {_context(row[col], pos, 40)}"
    opening = (row.get("raw_text") or "")[:80].replace("\n", " ").strip()
    return f"《{title}》 {opening}"


async def ai_candidates(uid: int, query: str, rows: list[dict] | None = None) -> list[tuple[str, str]]:
    """AI 搜索候选：SQL 粗筛 top 5；零命中兜底全量（硬上限 30 条）
    返回 [(task_id, 卡片文本)]——编号与 LLM prompt 中的序号一一对应
    rows：调用方已加载的 owner 行（传入时全链零额外 DB 读）"""
    if rows is None:
        rows = await load_owner_rows(uid)
    hits = await sql_search(uid, query, rows=rows)
    if hits:
        ids = {h["task_id"] for h in hits[:5]}
        sub = [r for r in rows if r["task_id"] in ids]
        order = {h["task_id"]: i for i, h in enumerate(hits[:5])}
        sub.sort(key=lambda r: order[r["task_id"]])
        return [(r["task_id"], slim_card(r, query)) for r in sub]
    return [(r["task_id"], slim_card(r, query)) for r in rows[:30]]
