"""
管线 LLM 处理层

使用 OpenAI 兼容 SDK 调用 DeepSeek（默认），提供三个能力：
  1. segment_text       — TXT 语义分段（默认自动执行）
  2. text_to_markdown   — 原文转写为结构化 Markdown（用户主动触发）
  3. summarize_text     — 内容总结概要（用户主动触发，增值功能）

切换 LLM 只需改 config.py 的 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL。
"""
import logging

from openai import OpenAI

from config import LLM_API_KEY, LLM_BASE_URL, LLM_MODEL

logger = logging.getLogger(__name__)

# ── 客户端实例（复用连接）───────────────────────────────
_client: OpenAI | None = None


def _get_client() -> OpenAI:
    """懒初始化 LLM 客户端，支持热更新 key。"""
    global _client
    if not LLM_API_KEY:
        raise RuntimeError(
            "LLM_API_KEY 未设置。请在 backend/.env 中配置 DeepSeek API Key。"
        )
    if _client is None or _client.api_key != LLM_API_KEY:
        _client = OpenAI(api_key=LLM_API_KEY, base_url=LLM_BASE_URL)
    return _client


# ── Prompt 设计 ───────────────────────────────────────

_SEGMENT_SYSTEM = (
    "你是一个专业的文本整理助手。"
    "用户会给你一段由语音识别（ASR）生成的原始转录文本，"
    "这段文本是按固定时间间隔切分后拼接的，可能存在句子在中间被截断、段落不自然的问题。\n\n"
    "你的任务：\n"
    "1. 按语义将文本重新分段，让每一段表达一个完整的意思。\n"
            "2. 在段落之间用空行分隔，提升可读性。\n"
            "3. 可以在段内适当修正明显的标点缺失（如句末加句号）。\n\n"
            "严格约束：\n"
            "- 必须保留原文的全部内容，不得删除、改写、总结或新增任何信息。\n"
            "- 保持原文语言（英文原文输出英文，中文原文输出中文），不得翻译。\n"
            "- 不得改变句子顺序。\n"
            "- 只做分段和标点修正，不改写措辞。\n"
            "- 直接输出整理后的文本，不要加任何解释、前言或 Markdown 标记。"
)

_MD_SYSTEM = (
    "你是一个专业的笔记整理助手。"
    "用户会给你一段由语音识别（ASR）生成的原始转录文本，需要你将其转写为结构化的 Markdown 笔记。\n\n"
            "你的任务：\n"
            "1. 根据内容的逻辑结构划分章节，使用 `##` 二级标题命名每个章节（标题简练，概括该节主题）。\n"
            "2. 对段落中的关键句、核心概念、重要结论，使用 **加粗** 突出。\n"
            "3. 对值得特别关注的名言、定义、金句，使用 > 引用块呈现。\n"
            "4. 对补充说明、示例、次要信息，可以使用 *倾斜* 标注。\n"
            "5. 遇到明显的列举（如多个要点），可转为列表格式。\n\n"
            "严格约束：\n"
            "- 这是基于原文的浅层结构化转写，不是深度分析或总结。\n"
            "- 保持原文语言（英文原文输出英文，中文原文输出中文），不得翻译。\n"
            "- 保留原文的实质内容，不得删减信息或大幅改写。\n"
            "- 允许为了逻辑通顺添加少量衔接词或过渡句。\n"
            "- 不得编造原文没有的内容。\n"
            "- 直接输出 Markdown 内容，不要加代码块包裹，不要加任何前言或解释。"
)

_SUMMARY_SYSTEM = (
    "你是一个视频内容总结助手。"
    "用户会给你一段视频的字幕文本，需要你生成一份结构化的内容概要，让读者一眼就知道这个视频在讲什么。\n\n"
    "你的任务：\n"
    "1. 开头用一段话（100-200 字）概括视频的核心主题和主要论点。\n"
    "2. 然后提炼 3-5 个核心要点，每个要点用一句话概括，必要时补一句展开说明。\n"
    "3. 如果视频包含明显的方法论、步骤、清单或关键数据，单独提炼一个小节。\n"
    "4. 最后可选地用一句话点出这个视频的价值或适合的人群（没有就省略）。\n\n"
    "格式要求：\n"
    "- 用 Markdown 输出：概述用普通段落，要点用 `- ` 无序列表，小节用 `###` 标题。\n"
    "- 总长度控制在 300-500 字，精炼但不空洞。\n\n"
    "严格约束：\n"
    "- 基于字幕原文总结，不得编造字幕里没有的内容。\n"
    "- 这是总结提炼（高度浓缩），不是原文转写——要提炼观点，不要复述原文。\n"
    "- 直接输出内容，不要加代码块包裹，不要加任何前言、解释或标题。"
)

# 字幕过长截断阈值（约 4 小时视频；DeepSeek 128K 上下文足够，截断只为控制成本）
_CHAT_SUBTITLE_MAX_CHARS = 40000


def _build_chat_system(raw_text: str, video_title: str) -> str:
    """
    组装对话 system prompt（含字幕全文）。
    注意：同一任务的返回值必须逐字一致——DeepSeek 磁盘缓存按前缀匹配，
    system 不变才能让后续轮次命中缓存（输入价 1/8）。
    """
    truncated = len(raw_text) > _CHAT_SUBTITLE_MAX_CHARS
    subtitle = raw_text[:_CHAT_SUBTITLE_MAX_CHARS]
    trunc_note = (
        "\n（注意：原视频字幕过长，此处仅提供前段内容，视频结尾部分的问题请如实说明无法回答。）"
        if truncated else ""
    )
    return (
        "你是一个视频内容解读助手。用户正在观看一个视频，并基于该视频的字幕文本向你提问。\n\n"
        f"视频标题：《{video_title}》\n\n"
        f"视频字幕全文：\n{subtitle}{trunc_note}\n\n"
        "回答要求：\n"
        "1. 以字幕为主要依据回答；可以基于字幕做合理的分析、延伸思考与启发式讨论。\n"
        "2. 明确区分「视频中提到的」与「你的延伸解读」——延伸部分用“视频里没有直接说，但可以从……延伸”这类措辞标注。\n"
        "3. 不得编造视频中不存在的具体事实、数据或引用；字幕里完全没有依据的，如实说明。\n"
        "4. 引用具体内容时，说明它出现在视频的大致位置（开头/中段/结尾）。\n"
        "5. 用 Markdown 组织回答（要点列表、加粗关键概念）；充分展开，一般 300-800 字，复杂问题可更长。\n"
        "6. 用户用中文提问，始终用中文回答。"
    )


# ── 核心函数 ──────────────────────────────────────────

def segment_text(raw_text: str, task_id: str) -> str:
    """
    TXT 语义分段：将原始 ASR 转录文本按语义重新分段。

    Args:
        raw_text: 原始拼接文本（按时间切片，可能有截断）
        task_id: 任务 ID（日志追踪）

    Returns:
        分段整理后的纯文本（段落间空行分隔）
    """
    if not raw_text or not raw_text.strip():
        logger.warning("[LLM] 空文本，跳过分段 (task=%s)", task_id)
        return raw_text

    client = _get_client()
    logger.info("[LLM] 语义分段开始: %d 字符 (task=%s)", len(raw_text), task_id)

    try:
        completion = client.chat.completions.create(
            model=LLM_MODEL,
            messages=[
                {"role": "system", "content": _SEGMENT_SYSTEM},
                {"role": "user", "content": raw_text},
            ],
            temperature=0.3,   # 低温度，保证忠实原文
            stream=False,
        )
        result = completion.choices[0].message.content or ""
        result = result.strip()

        logger.info("[LLM] 语义分段完成: %d → %d 字符 (task=%s)",
                    len(raw_text), len(result), task_id)
        return result

    except Exception as e:
        logger.error("[LLM] 语义分段失败，回退原文 (task=%s): %s", task_id, e)
        # 失败时回退到原文，不阻断主管线
        return raw_text


def text_to_markdown(raw_text: str, task_id: str) -> str:
    """
    原文转写 Markdown：将 ASR 转录文本转为结构化 Markdown 笔记。

    Args:
        raw_text: 原始拼接文本
        task_id: 任务 ID（日志追踪）

    Returns:
        结构化 Markdown 文本（含标题/加粗/引用等）

    Raises:
        Exception: 调用失败时抛出（此为用户主动触发的增值功能，失败应告知用户）
    """
    if not raw_text or not raw_text.strip():
        raise ValueError("空文本，无法转换为 Markdown")

    client = _get_client()
    logger.info("[LLM] Markdown 转写开始: %d 字符 (task=%s)", len(raw_text), task_id)

    completion = client.chat.completions.create(
        model=LLM_MODEL,
        messages=[
            {"role": "system", "content": _MD_SYSTEM},
            {"role": "user", "content": raw_text},
        ],
        temperature=0.5,   # 略高温度，允许少量结构化创造
        stream=False,
    )
    result = (completion.choices[0].message.content or "").strip()

    # 防止模型用代码块包裹整个输出
    if result.startswith("```markdown"):
        result = result[len("```markdown"):].lstrip("\n")
        if result.endswith("```"):
            result = result[:-3].rstrip("\n")

    logger.info("[LLM] Markdown 转写完成: %d 字符 (task=%s)", len(result), task_id)
    return result


def summarize_text(raw_text: str, task_id: str) -> str:
    """
    内容总结概要：将字幕文本浓缩为结构化概要（增值功能，用户主动触发）。

    Args:
        raw_text: 原始字幕文本
        task_id: 任务 ID（日志追踪）

    Returns:
        Markdown 格式的总结概要（概述 + 核心要点）

    Raises:
        Exception: 调用失败时抛出（增值功能，失败应告知用户）
    """
    if not raw_text or not raw_text.strip():
        raise ValueError("空文本，无法生成总结")

    client = _get_client()
    logger.info("[LLM] 总结概要开始: %d 字符 (task=%s)", len(raw_text), task_id)

    completion = client.chat.completions.create(
        model=LLM_MODEL,
        messages=[
            {"role": "system", "content": _SUMMARY_SYSTEM},
            {"role": "user", "content": raw_text},
        ],
        temperature=0.4,   # 总结需要一定概括创造，但不宜过高以免偏离原文
        stream=False,
    )
    result = (completion.choices[0].message.content or "").strip()

    # 防止模型用代码块包裹整个输出
    if result.startswith("```markdown"):
        result = result[len("```markdown"):].lstrip("\n")
        if result.endswith("```"):
            result = result[:-3].rstrip("\n")

    logger.info("[LLM] 总结概要完成: %d 字符 (task=%s)", len(result), task_id)
    return result



def chat_with_subtitle_stream(
    raw_text: str,
    video_title: str,
    history: list[dict],
    task_id: str,
):
    """
    AI 解读对话（SSE 流式）：基于字幕全文回答用户提问（增值功能，用户主动触发）。

    Args:
        raw_text: 原始字幕文本（放 system，逐字一致以命中 DeepSeek 前缀缓存）
        video_title: 视频标题（同样参与 system，保持一致性）
        history: 对话轮次 [{"role": "user"|"assistant", "content": str}]
                 主路由已兜底截断（最近 8 条、单条 2000 字），本轮提问已追加为末条
        task_id: 任务 ID（日志追踪）

    Yields:
        ("delta", str)   — 回复正文片段（逐步追加）
        ("done", dict)   — 结束，带 usage（prompt/completion/cache_hit/cache_miss tokens）

    Raises:
        Exception: 调用失败时抛出（路由层转 SSE error 事件）
    """
    if not raw_text or not raw_text.strip():
        raise ValueError("字幕文本缺失，无法进行对话")

    client = _get_client()
    messages = [{"role": "system", "content": _build_chat_system(raw_text, video_title)}]
    for msg in history:
        if msg.get("role") in ("user", "assistant") and msg.get("content"):
            messages.append({"role": msg["role"], "content": msg["content"]})

    logger.info("[LLM] AI 对话开始(流式): 字幕 %d 字符, 历史 %d 轮 (task=%s)",
                len(raw_text), len(history), task_id)

    stream = client.chat.completions.create(
        model=LLM_MODEL,
        messages=messages,
        temperature=0.5,
        max_tokens=2500,   # 回复长度硬限，控制输出成本
        stream=True,
        stream_options={"include_usage": True},   # 末 chunk 带 usage（含缓存命中明细）
    )

    total_chars = 0
    for chunk in stream:
        # 正文片段
        if chunk.choices and chunk.choices[0].delta.content:
            piece = chunk.choices[0].delta.content
            total_chars += len(piece)
            yield ("delta", piece)
        # usage 在最后一个 chunk（choices 为空）
        if getattr(chunk, "usage", None):
            u = chunk.usage
            usage = {
                "prompt_tokens": u.prompt_tokens,
                "completion_tokens": u.completion_tokens,
                "cache_hit_tokens": getattr(u, "prompt_cache_hit_tokens", 0) or 0,
                "cache_miss_tokens": getattr(u, "prompt_cache_miss_tokens", 0) or 0,
            }
            logger.info(
                "[LLM] AI 对话完成: %d 字符, prompt=%d(命中缓存 %d), completion=%d (task=%s)",
                total_chars, usage["prompt_tokens"], usage["cache_hit_tokens"],
                usage["completion_tokens"], task_id,
            )
            yield ("done", usage)
