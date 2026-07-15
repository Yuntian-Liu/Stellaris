"""
管线第 2 步（可选）：尝试抓取 B站 CC 字幕
需要用户提供的 sessdata；不保证成功，失败则 fallback 到 ASR
"""
import json
import urllib.request
import urllib.parse


def fetch_cc_subtitle(bvid: str, cid: int, sessdata: str) -> list[dict]:
    """
    尝试通过 B站 API 获取 CC 字幕
    返回: [{"lang": str, "url": str, "body": str}] 或空列表
    """
    # 1. 先通过 player v2 接口获取字幕列表
    player_url = f"https://api.bilibili.com/x/player/wbi/v2?bvid={bvid}&cid={cid}"
    req = urllib.request.Request(
        player_url,
        headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
            "Cookie": f"SESSDATA={sessdata}",
        },
    )
    try:
        resp = urllib.request.urlopen(req, timeout=15)
        data = json.loads(resp.read())
    except Exception as e:
        print(f"[subtitle] player API 调用失败: {e}")
        return []

    subtitles = data.get("data", {}).get("subtitle", {}).get("subtitles", [])
    if not subtitles:
        print(f"[subtitle] 无 CC 字幕可用")
        return []

    results = []
    for sub in subtitles:
        sub_url = sub.get("url", "")
        lang = sub.get("lan", "unknown")

        # 2. 下载字幕 JSON 内容
        try:
            sub_req = urllib.request.Request(
                sub_url,
                headers={"User-Agent": "Mozilla/5.0"},
            )
            sub_resp = urllib.request.urlopen(sub_req, timeout=15)
            body = json.loads(sub_resp.read())
            results.append({
                "lang": lang,
                "url": sub_url,
                "body": body,  # B站字幕 JSON 格式
            })
        except Exception as e:
            print(f"[subtitle] 下载字幕失败 ({lang}): {e}")
            continue

    return results
