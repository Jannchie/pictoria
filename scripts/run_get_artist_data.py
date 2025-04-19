import httpx
import asyncio


async def download_from_danbooru(tag):
    """从 Danbooru 下载指定标签的图片。"""
    url = "http://localhost:4777/v2/cmd/download-from-danbooru"
    headers = {"accept": "application/json"}
    params = {"tags": tag}

    timeout = httpx.Timeout(30000)
    async with httpx.AsyncClient(timeout=timeout) as client:
        await client.post(url, headers=headers, params=params)
        print(f"Downloaded images for tag: {tag}")


async def main():
    # laod from ./tags.txt
    tags = []
    with open("./scripts/tags.txt", "r") as f:
        tags = [tag.strip() for tag in f.readlines() if tag != ""]
    # 循环调用 download_from_danbooru 函数
    for tag in tags:
        await download_from_danbooru(tag)


if __name__ == "__main__":
    asyncio.run(main())
