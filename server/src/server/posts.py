import asyncio
import io
import shutil
from dataclasses import dataclass
from typing import Annotated, ClassVar, Generic, Literal, TypeVar

import httpx
import litestar
from litestar import Controller
from litestar.datastructures import UploadFile
from litestar.enums import RequestEncodingType
from litestar.exceptions import HTTPException, NotFoundException
from litestar.params import Body
from litestar.status_codes import HTTP_409_CONFLICT
from msgspec import Meta, Struct
from PIL import Image
from pydantic import BaseModel, ConfigDict

import shared
from db.repositories.posts import PostRepo
from db.repositories.tags import TagGroupRepo
from db.repositories.vectors import VectorRepo
from scheme import DTOBaseModel, PostDetailPublic, PostHasColorPublic
from utils import calculate_sha256, calculate_thumbhash, create_thumbnail_by_image, get_path_name_and_extension

MAX_POST_SCORE = 5
MAX_POST_RATING = 4


class PostFilter(Struct):
    rating: Annotated[tuple[int, ...] | None, Meta(description="Rating filter.", examples=[(1, 2, 3)])] = ()
    score: Annotated[tuple[int, ...] | None, Meta(description="Score filter.", examples=[(1, 2, 3)])] = ()
    tags: Annotated[tuple[str, ...] | None, Meta(description="Tag filter.", examples=[("tag1", "tag2")])] = ()
    extension: Annotated[tuple[str, ...] | None, Meta(description="Extension filter.", examples=[("jpg", "png")])] = ()
    folder: str | None = None
    lab: Annotated[
        tuple[float, float, float] | None,
        Meta(description="LAB color filter.", examples=[(0.5, 0.5, 0.5)],
             extra_json_schema={"min_length": 3, "max_length": 3}),
    ] = None
    waifu_score_range: Annotated[
        tuple[float, float] | None,
        Meta(description="Waifu score range filter.", examples=[(0.0, 10.0)],
             extra_json_schema={"min_length": 2, "max_length": 2}),
    ] = None
    waifu_score_levels: Annotated[
        tuple[str, ...] | None,
        Meta(
            description=(
                "Waifu-score bucket filter. Each value is one of "
                "'S' (8-10), 'A' (6-8), 'B' (4-6), 'C' (2-4), 'D' (0-2), "
                "or 'UNSCORED' (no waifu score yet). Multiple values OR together."
            ),
            examples=[("S", "A")],
        ),
    ] = ()


class PostFilterWithOrder(PostFilter):
    order_by: Annotated[
        Literal["id", "score", "rating", "created_at", "published_at", "file_name"] | None,
        Meta(description="Order column.", examples=["id"],
             extra_json_schema={"enum": ["id", "score", "rating", "created_at", "published_at", "file_name"]}),
    ] = None
    order: Annotated[
        Literal["asc", "desc", "random"],
        Meta(description="Order direction.", examples=["desc", "asc", "random"],
             extra_json_schema={"enum": ["asc", "desc", "random"]}),
    ] = "desc"


class TextSearchRequest(Struct):
    query: Annotated[str, Meta(description="Natural-language search prompt.", min_length=1)]


@dataclass
class CountPostsResponse:
    count: int


@dataclass
class RatingCountItem:
    rating: int
    count: int


@dataclass
class ScoreCountItem:
    score: int
    count: int


@dataclass
class ExtensionCountItem:
    extension: str
    count: int


@dataclass
class WaifuBucketCountItem:
    bucket: str  # one of 'S', 'A', 'B', 'C', 'D', 'UNSCORED'
    count: int


class PostStatsResponse(DTOBaseModel):
    total: int
    avg_score: float | None
    scored_count: int
    avg_waifu_score: float | None
    waifu_count: int
    rating_distribution: list[RatingCountItem]


T = TypeVar("T")


class CursorResponse(DTOBaseModel, Generic[T]):
    items: list[T]
    next_cursor: None | int = None


class ScoreUpdate(Struct):
    score: Annotated[int, Meta(ge=0, le=5, description="Score from 0 to 5.")]


class PostSimplePublic(DTOBaseModel):
    id: int
    file_path: str
    file_name: str
    extension: str
    rating: int
    width: int
    height: int
    aspect_ratio: float | None = None
    dominant_color: list[float] | None = None
    thumbhash: str | None = None
    colors: list[PostHasColorPublic]
    sha256: str


def _filter_dict(data: PostFilter) -> dict:
    return {
        "rating": data.rating,
        "score": data.score,
        "tags": data.tags,
        "extension": data.extension,
        "folder": data.folder,
        "waifu_score_range": data.waifu_score_range,
        "waifu_score_levels": data.waifu_score_levels,
    }


class PostController(Controller):
    path = "/posts"
    tags: ClassVar[list[str]] = ["Posts"]  # type: ignore

    @litestar.post("/search", status_code=200, description="Search for posts by filters.")
    async def search_posts(
        self,
        posts: PostRepo,
        data: PostFilterWithOrder,
        limit: int = 100,
        offset: int = 0,
    ) -> list[PostSimplePublic]:
        rows = await posts.search_simple(
            **_filter_dict(data),
            lab=data.lab,
            order_by=data.order_by,
            order=data.order,
            limit=limit,
            offset=offset,
        )
        return [PostSimplePublic.model_validate(r) for r in rows]

    @litestar.post("/search/text", status_code=200, description="Search posts by CLIP text embedding.")
    async def search_posts_by_text(
        self,
        posts: PostRepo,
        vectors: VectorRepo,
        data: TextSearchRequest,
        limit: int = 100,
    ) -> list[PostSimplePublic]:
        prompt = data.query.strip()
        if not prompt:
            return []
        from server.utils.vec import get_text_vec  # noqa: PLC0415  # lazy: defer ML stack load until first use

        vec = await get_text_vec(prompt)
        sims = await vectors.similar(vec, limit=limit, skip_self=False)
        id_list = [s.post_id for s in sims]
        if not id_list:
            return []
        rows = await posts.list_simple_by_ids_preserving_order(id_list)
        return [PostSimplePublic.model_validate(r) for r in rows]

    @litestar.get("/", status_code=200, description="Get all posts.")
    async def list_posts(self, posts: PostRepo, start: int = 0, limit: int = 100) -> CursorResponse:
        if start < 0 or limit <= 0:
            raise HTTPException(detail="Start must be >= 0 and limit must be > 0.", status_code=HTTP_409_CONFLICT)
        items, next_cursor = await posts.list_paginated(start, limit)
        return CursorResponse(
            items=[PostDetailPublic.model_validate(i) for i in items],
            next_cursor=next_cursor,
        )

    @litestar.get("/{post_id:int}", status_code=200)
    async def get_post(self, posts: PostRepo, post_id: int) -> PostDetailPublic:
        detail = await posts.get_detail(post_id)
        if not detail:
            raise NotFoundException(detail=f"Post with id {post_id} not found.")
        return PostDetailPublic.model_validate(detail)

    @litestar.get("/{post_id:int}/similar", status_code=200)
    async def get_similar_posts(
        self,
        posts: PostRepo,
        vectors: VectorRepo,
        post_id: int,
        limit: int = 100,
    ) -> list[PostSimplePublic]:
        vec = await vectors.get(post_id)
        if vec is None:
            return []
        sims = await vectors.similar(vec, limit=limit, skip_self=True)
        id_list = [s.post_id for s in sims]
        if not id_list:
            return []
        rows = await posts.list_simple_by_ids_preserving_order(id_list)
        return [PostSimplePublic.model_validate(r) for r in rows]

    @litestar.post("/count", status_code=200, description="Count posts by filters.")
    async def get_posts_count(self, posts: PostRepo, data: PostFilter) -> CountPostsResponse:
        return CountPostsResponse(count=await posts.count(**_filter_dict(data)))

    @litestar.post("/count/rating", status_code=200, description="Count posts by rating.")
    async def get_rating_count(self, posts: PostRepo, data: PostFilter) -> list[RatingCountItem]:
        rows = await posts.count_by_column("rating", **_filter_dict(data))
        return [RatingCountItem(rating=r["rating"], count=r["count"]) for r in rows]

    @litestar.post("/count/score", status_code=200, description="Count posts by score.")
    async def get_score_count(self, posts: PostRepo, data: PostFilter) -> list[ScoreCountItem]:
        rows = await posts.count_by_column("score", **_filter_dict(data))
        return [ScoreCountItem(score=r["score"], count=r["count"]) for r in rows]

    @litestar.post("/count/extension", status_code=200, description="Count posts by extension.")
    async def get_extension_count(self, posts: PostRepo, data: PostFilter) -> list[ExtensionCountItem]:
        rows = await posts.count_by_column("extension", **_filter_dict(data))
        return [ExtensionCountItem(extension=r["extension"], count=r["count"]) for r in rows]

    @litestar.post("/count/waifu", status_code=200, description="Count posts by waifu-score bucket (S/A/B/C/D/UNSCORED).")
    async def get_waifu_bucket_count(self, posts: PostRepo, data: PostFilter) -> list[WaifuBucketCountItem]:
        rows = await posts.count_by_waifu_bucket(**_filter_dict(data))
        return [WaifuBucketCountItem(bucket=r["bucket"], count=r["count"]) for r in rows]

    @litestar.post("/stats", status_code=200, description="Aggregate quality stats (avg score, avg waifu, rating distribution) for posts matching filter.")
    async def get_posts_stats(self, posts: PostRepo, data: PostFilter) -> PostStatsResponse:
        s = await posts.aggregate_stats(**_filter_dict(data))
        return PostStatsResponse(
            total=s["total"],
            avg_score=s["avg_score"],
            scored_count=s["scored_count"],
            avg_waifu_score=s["avg_waifu_score"],
            waifu_count=s["waifu_count"],
            rating_distribution=[RatingCountItem(rating=r["rating"], count=r["count"]) for r in s["rating_distribution"]],
        )

    @litestar.put("/{post_id:int}/score")
    async def update_post_score(self, posts: PostRepo, post_id: int, data: ScoreUpdate) -> PostDetailPublic:
        result = await posts.update_field(post_id, "score", data.score)
        if not result:
            raise NotFoundException(detail=f"Post with id {post_id} not found.")
        return PostDetailPublic.model_validate(await posts.get_detail(post_id))

    @litestar.put("/{post_id:int}/rating")
    async def update_post_rating(self, posts: PostRepo, post_id: int, rating: int) -> PostDetailPublic:
        result = await posts.update_field(post_id, "rating", rating)
        if not result:
            raise NotFoundException(detail=f"Post with id {post_id} not found.")
        return PostDetailPublic.model_validate(await posts.get_detail(post_id))

    @litestar.put("/{post_id:int}/caption")
    async def update_post_caption(self, posts: PostRepo, post_id: int, caption: str) -> PostDetailPublic:
        result = await posts.update_field(post_id, "caption", caption)
        if not result:
            raise NotFoundException(detail=f"Post with id {post_id} not found.")
        return PostDetailPublic.model_validate(await posts.get_detail(post_id))

    @litestar.put("/{post_id:int}/source")
    async def update_post_source(self, posts: PostRepo, post_id: int, source: str) -> PostDetailPublic:
        result = await posts.update_field(post_id, "source", source)
        if not result:
            raise NotFoundException(detail=f"Post with id {post_id} not found.")
        return PostDetailPublic.model_validate(await posts.get_detail(post_id))

    @litestar.delete("/delete")
    async def delete_posts(self, posts: PostRepo, ids: list[int]) -> None:
        await posts.delete_many(ids)

    @litestar.put("/{post_id:int}/rotate")
    async def rotate_post_image(self, posts: PostRepo, post_id: int, *, clockwise: bool = True) -> PostDetailPublic:
        """Rotate post image by id; updates sha256/width/height/thumbhash."""
        post = await posts.get(post_id)
        if post is None:
            raise NotFoundException(detail=f"Post with id {post_id} not found.")

        def _rotate_and_describe() -> tuple[str, int, int, str | None]:
            image = Image.open(post.absolute_path)
            image = image.rotate(-90 if clockwise else 90, expand=True)
            image.save(post.absolute_path)
            create_thumbnail_by_image(image, post.thumbnail_path)
            sha = calculate_sha256(image.tobytes())
            th = calculate_thumbhash(image)
            return sha, image.size[0], image.size[1], th

        sha, w, h, th = await asyncio.to_thread(_rotate_and_describe)
        await posts.update_for_rotate(post_id, sha256=sha, width=w, height=h, thumbhash=th)
        return PostDetailPublic.model_validate(await posts.get_detail(post_id))

    @litestar.put("/{post_id:int}/tags/{tag_name:str}")
    async def add_tag_to_post(self, posts: PostRepo, post_id: int, tag_name: str) -> PostDetailPublic:
        post = await posts.get(post_id)
        if not post:
            raise NotFoundException(detail=f"Post with id {post_id} not found.")
        inserted = await posts.add_tag(post_id, tag_name)
        if not inserted:
            raise HTTPException(
                detail=f"Tag {tag_name} already exists in post {post_id}.",
                status_code=HTTP_409_CONFLICT,
            )
        return PostDetailPublic.model_validate(await posts.get_detail(post_id))

    @litestar.delete("/{post_id:int}/tags/{tag_name:str}", status_code=200)
    async def remove_tag_from_post(self, posts: PostRepo, post_id: int, tag_name: str) -> PostDetailPublic:
        post = await posts.get(post_id)
        if not post:
            raise NotFoundException(detail=f"Post with id {post_id} not found.")
        removed = await posts.remove_tag(post_id, tag_name)
        if not removed:
            raise HTTPException(
                detail=f"Tag {tag_name} does not exist in post {post_id}.",
                status_code=HTTP_409_CONFLICT,
            )
        return PostDetailPublic.model_validate(await posts.get_detail(post_id))

    @litestar.put("/bulk/score")
    async def bulk_update_post_score(self, posts: PostRepo, ids: list[int], score: int) -> None:
        if not 0 <= score <= MAX_POST_SCORE:
            raise HTTPException(detail=f"Score must be between 0 and {MAX_POST_SCORE}, got {score}.", status_code=HTTP_409_CONFLICT)
        await posts.bulk_update_field(ids, "score", score)

    @litestar.put("/bulk/rating")
    async def bulk_update_post_rating(self, posts: PostRepo, ids: list[int], rating: int) -> None:
        if not 0 <= rating <= MAX_POST_RATING:
            raise HTTPException(detail=f"Rating must be between 0 and {MAX_POST_RATING}, got {rating}.", status_code=HTTP_409_CONFLICT)
        await posts.bulk_update_field(ids, "rating", rating)

    class UploadFormData(BaseModel):
        model_config = ConfigDict(arbitrary_types_allowed=True)
        url: str | None = None
        path: str | None = None
        source: str | None = None
        file: UploadFile

    @litestar.post("/upload", tags=["Upload"])
    async def upload_file(
        self,
        posts: PostRepo,
        vectors: VectorRepo,
        tag_group_repo: TagGroupRepo,
        data: Annotated[UploadFormData, Body(media_type=RequestEncodingType.MULTI_PART)],
    ) -> None:
        path = data.path
        url = data.url
        file = data.file
        source = data.source or "unknown"
        if data.file is None and data.url is None:
            raise HTTPException(status_code=400, detail="Either file or url must be provided")
        if data.file is None:
            headers = {
                "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
            }
            if data.url and "pximg.net" in data.url:
                headers["referer"] = "https://www.pixiv.net/"
            async with httpx.AsyncClient() as client:
                resp = await client.get(data.url, headers=headers)
            file_io = io.BytesIO(resp.content)
        else:
            file_io = file.file

        if not path and file is not None and file.filename:
            path = file.filename
        elif path and file is not None and file.filename:
            path = f"{path}/{file.filename}"
        else:
            path = path or (url.split("/")[-1] if url else "")

        abs_path = shared.target_dir / path
        abs_path.parent.mkdir(parents=True, exist_ok=True)
        file_path, file_name, file_ext = get_path_name_and_extension(abs_path)
        if abs_path.exists():
            raise HTTPException(status_code=400, detail="File already exists")

        await posts.create(
            file_path=file_path,
            file_name=file_name,
            extension=file_ext,
            source=source,
        )
        with abs_path.open("wb") as f:
            await asyncio.to_thread(shutil.copyfileobj, file_io, f)
        from processors import process_post  # noqa: PLC0415  # lazy: defer ML stack load until first use

        await process_post(posts, vectors, tag_group_repo, abs_path)
