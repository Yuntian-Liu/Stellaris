"""
B站官方 API 直连层（纯标准库，无新增依赖）

背景：yt-dlp 的 BiliBili extractor 第一步必抓视频 HTML 页面，
B站对数据中心 IP 的网页抓取一律 412；但 api.bilibili.com 的 JSON
接口不做此风控（Zeabur 终端实测 view/playurl/CDN 全链路畅通）。
因此 B站链接走本模块直连 API，其他站点仍走 yt-dlp（见 download.py）。
"""
import json
import re
import urllib.request
from pathlib import Path

# 浏览器 UA，B站 API 要求带 UA + Referer，否则 403
_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
       "AppleWebKit/537.36 (KHTML, like Gecko) "
       "Chrome/128.0.0.0 Safari/537.36")

_BV_RE = re.compile(r"(BV[0-9A-Za-z]{10})")

# 不跟随 302 的 opener：b23.tv 短链只取 Location 头，
# 不能跟跳——跳转目标是视频 HTML 页，正是被 412 风控的那步
_no_redirect_opener = urllib.request.build_opener(
    type("_NoRedirect", (urllib.request.HTTPRedirectHandler,), {
        "redirect_request": lambda self, req, fp, code, msg, h, newurl: None,
    })()
)


def is_bilibili_url(url: str) -> bool:
    """是否 B站链接（含 b23.tv 短链）——是则走本模块，否则走 yt-dlp"""
    return "bilibili.com" in url or "b23.tv" in url


def _open(url: str, sessdata: str | None = None, timeout: int = 30):
    """带浏览器 UA + Referer 发请求；有 SESSDATA 时带上（会员视频/更松风控）"""
    headers = {"User-Agent": _UA, "Referer": "https://www.bilibili.com"}
    if sessdata:
        headers["Cookie"] = f"SESSDATA={sessdata}"
    req = urllib.request.Request(url, headers=headers)
    return urllib.request.urlopen(req, timeout=timeout)


def resolve_bvid(url: str, sessdata: str | None = None) -> str:
    """从链接提取 BV 号；b23.tv 短链只读 302 的 Location 头（不跟跳 HTML 页）"""
    if "b23.tv" in url:
        headers = {"User-Agent": _UA, "Referer": "https://www.bilibili.com"}
        if sessdata:
            headers["Cookie"] = f"SESSDATA={sessdata}"
        req = urllib.request.Request(url, headers=headers)
        try:
            resp = _no_redirect_opener.open(req, timeout=30)
            try:
                url = resp.headers.get("Location", "")
            finally:
                resp.close()
        except urllib.error.HTTPError as e:
            # 不跟跳时 302 会以异常形式抛出，Location 就在异常头里
            if e.code in (301, 302, 303, 307, 308):
                url = e.headers.get("Location", "")
            else:
                raise
    m = _BV_RE.search(url)
    if not m:
        raise RuntimeError(f"无法从链接解析 BV 号: {url}")
    return m.group(1)


def fetch_video_info(bvid: str, sessdata: str | None = None) -> dict:
    """view API 拿元数据。返回 {bvid, cid, title, duration_sec}"""
    resp = _open(
        f"https://api.bilibili.com/x/web-interface/view?bvid={bvid}",
        sessdata,
    )
    try:
        d = json.loads(resp.read())
    finally:
        resp.close()
    if d.get("code") != 0:
        raise RuntimeError(f"B站接口错误: {d.get('message', d.get('code'))}")
    v = d["data"]
    return {
        "bvid": bvid,
        "cid": v["cid"],
        "title": (v.get("title") or "Unknown Title")[:200],
        "duration_sec": float(v["duration"]),
    }


def fetch_audio_url(bvid: str, cid: int, sessdata: str | None = None) -> str:
    """playurl API 拿 DASH 音频直链（fnval=16），取码率最高的一路"""
    resp = _open(
        f"https://api.bilibili.com/x/player/playurl"
        f"?bvid={bvid}&cid={cid}&fnval=16&fnver=0",
        sessdata,
    )
    try:
        d = json.loads(resp.read())
    finally:
        resp.close()
    if d.get("code") != 0:
        raise RuntimeError(f"B站接口错误: {d.get('message', d.get('code'))}")
    audios = d["data"].get("dash", {}).get("audio") or []
    if not audios:
        raise RuntimeError("未获取到音频流（视频可能受限或需登录，可尝试填写 SESSDATA）")
    best = max(audios, key=lambda a: a.get("bandwidth", 0))
    return best["baseUrl"]


def download_to_file(
    url: str,
    dest: Path,
    sessdata: str | None = None,
    timeout: int = 300,
) -> None:
    """流式下载 CDN 音频到本地文件（B站 CDN 校验 Referer，必须带头）"""
    resp = _open(url, sessdata, timeout=timeout)
    try:
        with open(dest, "wb") as f:
            while chunk := resp.read(1 << 20):   # 1MB 一块
                f.write(chunk)
    finally:
        resp.close()
