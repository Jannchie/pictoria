import asyncio
import math
from dataclasses import dataclass
from typing import Annotated, ClassVar, Generic, TypeVar

import litestar
from litestar import Controller
from litestar.datastructures import UploadFile
from litestar.enums import RequestEncodingType
from litestar.params import Body
from msgspec import Meta, Struct
from PIL import Image
from pydantic import BaseModel, ConfigDict

from db.filters import PostFilter, PostFilterWithOrder
from db.queries.post_query import PostQueryService
from db.repositories.posts import PostRepo
from db.repositories.tags import TagRepo
from db.repositories.vectors import VectorRepo
from scheme import DTOBaseModel, PostDetailPublic, PostHasColorPublic
from server.exceptions import (
    InvalidArgumentError,
    PostNotFoundError,
    TagAlreadyExistsError,
    TagNotOnPostError,
)
from services.intake import UploadIntake
from shared import MAX_POST_RATING, MAX_POST_SCORE
from utils import calculate_arthash, calculate_sha256, create_thumbnail_by_image


class TextSearchRequest(PostFilter):
    # Text search combinable with the standard post filters: every inherited
    # PostFilter field narrows the candidate set, then results are ranked by
    # SigLIP 2 cosine similarity to ``query``. An empty query returns [].
    query: Annotated[str, Meta(description="Natural-language search prompt.")] = ""


class TagCountRequest(PostFilter):
    # Tag-facet counts for the searchable tag filter: inherited PostFilter fields
    # narrow the post set, then we count matching posts per tag. ``query``
    # substring-filters tag names; ``limit`` caps rows (by descending count).
    query: Annotated[str, Meta(description="Substring filter on tag names.")] = ""
    limit: Annotated[int, Meta(description="Max tags returned, by descending count.")] = 50


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
class TagCountItem:
    tag_name: str
    count: int


@dataclass
class WaifuBucketCountItem:
    bucket: str  # one of 'A', 'B', 'C', 'D', 'E', 'UNSCORED'
    count: int


@dataclass
class SilvaBucketCountItem:
    bucket: str  # one of 'A', 'B', 'C', 'D', 'E', 'UNSCORED'
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
    score: Annotated[int, Meta(ge=0, le=MAX_POST_SCORE, description=f"Score from 0 to {MAX_POST_SCORE}.")]


class PostSimplePublic(DTOBaseModel):
    id: int
    file_path: str
    file_name: str
    extension: str
    rating: int
    score: int
    size: int
    width: int
    height: int
    aspect_ratio: float | None = None
    dominant_color: list[float] | None = None
    arthash: str | None = None
    colors: list[PostHasColorPublic]
    sha256: str
    # Populated only by /posts/search/text: SigLIP's official scoring is
    # `sigmoid(logit_scale.exp() * cos(t,i) + logit_bias)` — independent
    # per-pair probability that this image matches the text query.
    match_prob: float | None = None


class PostController(Controller):
    path = "/posts"
    tags: ClassVar[list[str]] = ["Posts"]  # type: ignore

    @litestar.post("/search", status_code=200, description="Search for posts by filters.")
    async def search_posts(
        self,
        post_query: PostQueryService,
        data: PostFilterWithOrder,
        limit: int = 100,
        offset: int = 0,
    ) -> list[PostSimplePublic]:
        rows = await post_query.search(data, limit=limit, offset=offset)
        return [PostSimplePublic.model_validate(r) for r in rows]

    @litestar.post(
        "/search/text",
        status_code=200,
        description="Search posts by SigLIP 2 text embedding, combinable with the standard post filters.",
    )
    async def search_posts_by_text(
        self,
        post_query: PostQueryService,
        data: TextSearchRequest,
        limit: int = 100,
    ) -> list[PostSimplePublic]:
        prompt = data.query.strip()
        if not prompt:
            return []
        # Lazy imports: defer the ML stack load until the first text search.
        from ai.siglip_embed import get_logit_scale_bias  # noqa: PLC0415
        from server.utils.vec import get_text_vec  # noqa: PLC0415

        vec = await get_text_vec(prompt)
        rows = await post_query.search_by_text_vector(vec, data, limit=limit)
        # SigLIP's official scoring: sigmoid(scale * cos + bias). Embeddings
        # are L2-normalised at the source (ai/siglip_embed.py), so vec0's
        # cosine distance is exactly (1 - cos) and we recover cos directly.
        scale, bias = await asyncio.to_thread(get_logit_scale_bias)
        for r in rows:
            dist = r.pop("_knn_distance", None)
            if dist is None:
                continue
            cos = 1.0 - float(dist)
            r["match_prob"] = 1.0 / (1.0 + math.exp(-(scale * cos + bias)))
        return [PostSimplePublic.model_validate(r) for r in rows]

    @litestar.get("/", status_code=200, description="Get all posts.")
    async def list_posts(self, post_query: PostQueryService, start: int = 0, limit: int = 100) -> CursorResponse:
        if start < 0 or limit <= 0:
            raise InvalidArgumentError("Start must be >= 0 and limit must be > 0.")  # noqa: EM101, TRY003
        items, next_cursor = await post_query.list_paginated(start, limit)
        return CursorResponse(
            items=[PostDetailPublic.model_validate(i) for i in items],
            next_cursor=next_cursor,
        )

    @litestar.get("/{post_id:int}", status_code=200)
    async def get_post(self, post_query: PostQueryService, post_id: int) -> PostDetailPublic:
        detail = await post_query.get_detail(post_id)
        if not detail:
            raise PostNotFoundError(post_id)
        return PostDetailPublic.model_validate(detail)

    @litestar.get("/{post_id:int}/similar", status_code=200)
    async def get_similar_posts(
        self,
        post_query: PostQueryService,
        vectors: VectorRepo,
        post_id: int,
        limit: int = 100,
    ) -> list[PostSimplePublic]:
        sims = await vectors.similar_to_post(post_id, limit=limit)
        id_list = [s.post_id for s in sims]
        if not id_list:
            return []
        rows = await post_query.list_simple_by_ids_preserving_order(id_list)
        return [PostSimplePublic.model_validate(r) for r in rows]

    @litestar.post("/count", status_code=200, description="Count posts by filters.")
    async def get_posts_count(self, post_query: PostQueryService, data: PostFilter) -> CountPostsResponse:
        return CountPostsResponse(count=await post_query.count(data))

    @litestar.post("/count/rating", status_code=200, description="Count posts by rating.")
    async def get_rating_count(self, post_query: PostQueryService, data: PostFilter) -> list[RatingCountItem]:
        rows = await post_query.count_by_column("rating", data)
        return [RatingCountItem(rating=r["rating"], count=r["count"]) for r in rows]

    @litestar.post("/count/score", status_code=200, description="Count posts by score.")
    async def get_score_count(self, post_query: PostQueryService, data: PostFilter) -> list[ScoreCountItem]:
        rows = await post_query.count_by_column("score", data)
        return [ScoreCountItem(score=r["score"], count=r["count"]) for r in rows]

    @litestar.post("/count/extension", status_code=200, description="Count posts by extension.")
    async def get_extension_count(self, post_query: PostQueryService, data: PostFilter) -> list[ExtensionCountItem]:
        rows = await post_query.count_by_column("extension", data)
        return [ExtensionCountItem(extension=r["extension"], count=r["count"]) for r in rows]

    @litestar.post("/count/tags", status_code=200, description="Count posts per tag (searchable, top-N by count).")
    async def get_tag_count(self, post_query: PostQueryService, data: TagCountRequest) -> list[TagCountItem]:
        rows = await post_query.count_by_tag(data, query=data.query, limit=data.limit)
        return [TagCountItem(tag_name=r["tag_name"], count=r["count"]) for r in rows]

    @litestar.post("/count/waifu", status_code=200, description="Count posts by waifu-score bucket (A/B/C/D/E/UNSCORED).")
    async def get_waifu_bucket_count(self, post_query: PostQueryService, data: PostFilter) -> list[WaifuBucketCountItem]:
        rows = await post_query.count_by_waifu_bucket(data)
        return [WaifuBucketCountItem(bucket=r["bucket"], count=r["count"]) for r in rows]

    @litestar.post("/count/silva", status_code=200, description="Count posts by SILVA aesthetic bucket (A/B/C/D/E/UNSCORED).")
    async def get_silva_bucket_count(self, post_query: PostQueryService, data: PostFilter) -> list[SilvaBucketCountItem]:
        rows = await post_query.count_by_silva_bucket(data)
        return [SilvaBucketCountItem(bucket=r["bucket"], count=r["count"]) for r in rows]

    @litestar.post("/stats", status_code=200, description="Aggregate quality stats (avg score, avg waifu, rating distribution) for posts matching filter.")
    async def get_posts_stats(self, post_query: PostQueryService, data: PostFilter) -> PostStatsResponse:
        s = await post_query.aggregate_stats(data)
        return PostStatsResponse(
            total=s["total"],
            avg_score=s["avg_score"],
            scored_count=s["scored_count"],
            avg_waifu_score=s["avg_waifu_score"],
            waifu_count=s["waifu_count"],
            rating_distribution=[RatingCountItem(rating=r["rating"], count=r["count"]) for r in s["rating_distribution"]],
        )

    @litestar.put("/{post_id:int}/score")
    async def update_post_score(self, posts: PostRepo, post_query: PostQueryService, post_id: int, data: ScoreUpdate) -> PostDetailPublic:
        return await self._update_and_return_detail(posts, post_query, post_id, "score", data.score)

    @litestar.put("/{post_id:int}/rating")
    async def update_post_rating(self, posts: PostRepo, post_query: PostQueryService, post_id: int, rating: int) -> PostDetailPublic:
        if not 0 <= rating <= MAX_POST_RATING:
            raise InvalidArgumentError(  # noqa: TRY003
                f"Rating must be between 0 and {MAX_POST_RATING}, got {rating}.",  # noqa: EM102
            )
        return await self._update_and_return_detail(posts, post_query, post_id, "rating", rating)

    @litestar.put("/{post_id:int}/caption")
    async def update_post_caption(self, posts: PostRepo, post_query: PostQueryService, post_id: int, caption: str) -> PostDetailPublic:
        return await self._update_and_return_detail(posts, post_query, post_id, "caption", caption)

    @litestar.put("/{post_id:int}/source")
    async def update_post_source(self, posts: PostRepo, post_query: PostQueryService, post_id: int, source: str) -> PostDetailPublic:
        return await self._update_and_return_detail(posts, post_query, post_id, "source", source)

    @staticmethod
    async def _update_and_return_detail(
        posts: PostRepo, post_query: PostQueryService, post_id: int, field: str, value: object,
    ) -> PostDetailPublic:
        if not await posts.update_field(post_id, field, value):
            raise PostNotFoundError(post_id)
        detail = await post_query.get_detail(post_id)
        if detail is None:
            raise PostNotFoundError(post_id)
        return PostDetailPublic.model_validate(detail)

    @litestar.post("/{post_id:int}/touch", status_code=204, description="Record a view by bumping last_accessed_at.")
    async def touch_post(self, posts: PostRepo, post_id: int) -> None:
        if not await posts.touch_accessed(post_id):
            raise PostNotFoundError(post_id)

    @litestar.delete("/delete")
    async def delete_posts(self, posts: PostRepo, ids: list[int]) -> None:
        await posts.delete_many(ids)

    @litestar.put("/{post_id:int}/rotate")
    async def rotate_post_image(self, posts: PostRepo, post_query: PostQueryService, post_id: int, *, clockwise: bool = True) -> PostDetailPublic:
        """Rotate post image by id; updates sha256/width/height/arthash."""
        post = await posts.get(post_id)
        if post is None:
            raise PostNotFoundError(post_id)

        def _rotate_and_describe() -> tuple[str, int, int, str | None]:
            image = Image.open(post.absolute_path)
            image = image.rotate(-90 if clockwise else 90, expand=True)
            image.save(post.absolute_path)
            create_thumbnail_by_image(image, post.thumbnail_path)
            sha = calculate_sha256(image.tobytes())
            ah = calculate_arthash(image)
            return sha, image.size[0], image.size[1], ah

        sha, w, h, ah = await asyncio.to_thread(_rotate_and_describe)
        await posts.update_for_rotate(post_id, sha256=sha, width=w, height=h, arthash=ah)
        return PostDetailPublic.model_validate(await post_query.get_detail(post_id))

    @litestar.put("/{post_id:int}/tags/{tag_name:str}")
    async def add_tag_to_post(
        self, posts: PostRepo, tag_repo: TagRepo, post_query: PostQueryService, post_id: int, tag_name: str,
    ) -> PostDetailPublic:
        post = await posts.get(post_id)
        if not post:
            raise PostNotFoundError(post_id)
        if not await tag_repo.add_tag(post_id, tag_name):
            raise TagAlreadyExistsError(post_id, tag_name)
        return PostDetailPublic.model_validate(await post_query.get_detail(post_id))

    @litestar.delete("/{post_id:int}/tags/{tag_name:str}", status_code=200)
    async def remove_tag_from_post(
        self, posts: PostRepo, tag_repo: TagRepo, post_query: PostQueryService, post_id: int, tag_name: str,
    ) -> PostDetailPublic:
        post = await posts.get(post_id)
        if not post:
            raise PostNotFoundError(post_id)
        if not await tag_repo.remove_tag(post_id, tag_name):
            raise TagNotOnPostError(post_id, tag_name)
        return PostDetailPublic.model_validate(await post_query.get_detail(post_id))

    @litestar.put("/bulk/score")
    async def bulk_update_post_score(self, posts: PostRepo, ids: list[int], score: int) -> None:
        if not 0 <= score <= MAX_POST_SCORE:
            raise InvalidArgumentError(  # noqa: TRY003
                f"Score must be between 0 and {MAX_POST_SCORE}, got {score}.",  # noqa: EM102
            )
        await posts.bulk_update_field(ids, "score", score)

    @litestar.put("/bulk/rating")
    async def bulk_update_post_rating(self, posts: PostRepo, ids: list[int], rating: int) -> None:
        if not 0 <= rating <= MAX_POST_RATING:
            raise InvalidArgumentError(  # noqa: TRY003
                f"Rating must be between 0 and {MAX_POST_RATING}, got {rating}.",  # noqa: EM102
            )
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
        upload_intake: UploadIntake,
        data: Annotated[UploadFormData, Body(media_type=RequestEncodingType.MULTI_PART)],
    ) -> None:
        await upload_intake.store(file=data.file, url=data.url, path=data.path, source=data.source)
