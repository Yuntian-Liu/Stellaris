"""
管线 LLM 处理层

使用 OpenAI 兼容 SDK 调用 DeepSeek（默认），提供两个能力：
  1. segment_text       — TXT 语义分段（默认自动执行）
  2. text_to_markdown   — 原文转写为结构化 Markdown（用户主动触发）

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
            "- 保留原文的实质内容，不得删减信息或大幅改写。\n"
            "- 允许为了逻辑通顺添加少量衔接词或过渡句。\n"
            "- 不得编造原文没有的内容。\n"
            "- 直接输出 Markdown 内容，不要加代码块包裹，不要加任何前言或解释。"
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
