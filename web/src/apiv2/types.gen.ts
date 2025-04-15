// This file is auto-generated by @hey-api/openapi-ts

export interface CountPostsResponse {
  count: number
}

export interface ExtensionCountItem {
  extension: string
  count: number
}

export interface ListPostBody {
  rating?: Array<number> | null
  score?: Array<number> | null
  tags?: Array<string> | null
  extension?: Array<string> | null
  folder?: string | null
  order_by?: 'id' | 'score' | 'rating' | 'created_at' | 'published_at' | 'file_name' | null
  order?: 'asc' | 'desc' | 'random'
  lab?: number | null
}

export interface Post {
  created_at: unknown
  updated_at: unknown
  id: unknown
  file_path?: unknown
  file_name?: unknown
  extension?: unknown
  full_path: unknown
  aspect_ratio: unknown
  width?: unknown
  height?: unknown
  published_at?: unknown
  score?: unknown
  rating?: unknown
  description?: unknown
  meta?: unknown
  md5?: unknown
  size?: unknown
  source?: unknown
  caption?: unknown
  dominant_color_np?: unknown
  tags?: unknown
  colors?: unknown
}

export interface RatingCountItem {
  rating: number
  count: number
}

export interface ScoreCountItem {
  score: number
  count: number
}

export interface ScoreUpdate {
  /**
   * Score from 0 to 5.
   */
  score: number
}

export interface ServerPostsPostControllerGetPostPostHasTagTagResponseBody {
  groupId?: number | null
  name: string
  createdAt: string
  updatedAt: string
}

export interface ServerPostsPostControllerGetPostPostResponseBody {
  filePath?: string
  fileName?: string
  extension?: string
  width?: number | null
  height?: number | null
  publishedAt?: string | null
  score?: number
  rating?: number
  description?: string
  meta?: string
  md5?: string
  size?: number
  source?: string
  caption?: string
  tags: Array<ServerPostsPostControllerGetPostPost0PostHasTagResponseBody>
  colors: Array<ServerPostsPostControllerGetPostPost0PostHasColorResponseBody>
  id: number
  fullPath?: string
  aspectRatio?: number | null
  createdAt: string
  updatedAt: string
  dominantColor?: Array<number> | null
  absolutePath: string
  thumbnailPath: string
}

export interface ServerPostsPostControllerGetPostPost0PostHasColorResponseBody {
  order: number
  color: number
}

export interface ServerPostsPostControllerGetPostPost0PostHasTagResponseBody {
  isAuto?: boolean
  tagInfo: ServerPostsPostControllerGetPostPostHasTagTagResponseBody
}

export interface ServerPostsPostControllerGetSimilarPostsPostHasTagTagResponseBody {
  groupId?: number | null
  name: string
  createdAt: string
  updatedAt: string
}

export interface ServerPostsPostControllerGetSimilarPostsPostResponseBody {
  filePath?: string
  fileName?: string
  extension?: string
  width?: number | null
  height?: number | null
  publishedAt?: string | null
  score?: number
  rating?: number
  description?: string
  meta?: string
  md5?: string
  size?: number
  source?: string
  caption?: string
  tags: Array<ServerPostsPostControllerGetSimilarPostsPost0PostHasTagResponseBody>
  colors: Array<ServerPostsPostControllerGetSimilarPostsPost0PostHasColorResponseBody>
  id: number
  fullPath?: string
  aspectRatio?: number | null
  createdAt: string
  updatedAt: string
  dominantColor?: Array<number> | null
  absolutePath: string
  thumbnailPath: string
}

export interface ServerPostsPostControllerGetSimilarPostsPost0PostHasColorResponseBody {
  order: number
  color: number
}

export interface ServerPostsPostControllerGetSimilarPostsPost0PostHasTagResponseBody {
  isAuto?: boolean
  tagInfo: ServerPostsPostControllerGetSimilarPostsPostHasTagTagResponseBody
}

export interface ServerPostsPostControllerSearchPostsPostHasTagTagResponseBody {
  groupId?: number | null
  name: string
  createdAt: string
  updatedAt: string
}

export interface ServerPostsPostControllerSearchPostsPostResponseBody {
  filePath?: string
  fileName?: string
  extension?: string
  width?: number | null
  height?: number | null
  publishedAt?: string | null
  score?: number
  rating?: number
  description?: string
  meta?: string
  md5?: string
  size?: number
  source?: string
  caption?: string
  tags: Array<ServerPostsPostControllerSearchPostsPost0PostHasTagResponseBody>
  colors: Array<ServerPostsPostControllerSearchPostsPost0PostHasColorResponseBody>
  id: number
  fullPath?: string
  aspectRatio?: number | null
  createdAt: string
  updatedAt: string
  dominantColor?: Array<number> | null
  absolutePath: string
  thumbnailPath: string
}

export interface ServerPostsPostControllerSearchPostsPost0PostHasColorResponseBody {
  order: number
  color: number
}

export interface ServerPostsPostControllerSearchPostsPost0PostHasTagResponseBody {
  isAuto?: boolean
  tagInfo: ServerPostsPostControllerSearchPostsPostHasTagTagResponseBody
}

export interface V2DeletePostsData {
  body?: never
  path?: never
  query: {
    ids: Array<number>
  }
  url: '/v2/posts/delete'
}

export interface V2DeletePostsErrors {
  /**
   * Validation Exception
   */
  400: {
    status_code: number
    detail: string
    extra?: null | Array<unknown> | Array<unknown>
  }
}

export type V2DeletePostsError = V2DeletePostsErrors[keyof V2DeletePostsErrors]

export interface V2DeletePostsResponses {
  /**
   * Request fulfilled, nothing follows
   */
  204: void
}

export type V2DeletePostsResponse = V2DeletePostsResponses[keyof V2DeletePostsResponses]

export interface V2GetExtensionCountData {
  body: ListPostBody
  path?: never
  query?: never
  url: '/v2/posts/count/extension'
}

export interface V2GetExtensionCountErrors {
  /**
   * Validation Exception
   */
  400: {
    status_code: number
    detail: string
    extra?: null | Array<unknown> | Array<unknown>
  }
}

export type V2GetExtensionCountError = V2GetExtensionCountErrors[keyof V2GetExtensionCountErrors]

export interface V2GetExtensionCountResponses {
  /**
   * Document created, URL follows
   */
  201: Array<ExtensionCountItem>
}

export type V2GetExtensionCountResponse = V2GetExtensionCountResponses[keyof V2GetExtensionCountResponses]

export interface V2GetPostData {
  body?: never
  path: {
    post_id: number
  }
  query?: never
  url: '/v2/posts/{post_id}'
}

export interface V2GetPostErrors {
  /**
   * Validation Exception
   */
  400: {
    status_code: number
    detail: string
    extra?: null | Array<unknown> | Array<unknown>
  }
}

export type V2GetPostError = V2GetPostErrors[keyof V2GetPostErrors]

export interface V2GetPostResponses {
  /**
   * Request fulfilled, document follows
   */
  200: ServerPostsPostControllerGetPostPostResponseBody
}

export type V2GetPostResponse = V2GetPostResponses[keyof V2GetPostResponses]

export interface V2GetPostsCountData {
  body: ListPostBody
  path?: never
  query?: never
  url: '/v2/posts/count'
}

export interface V2GetPostsCountErrors {
  /**
   * Validation Exception
   */
  400: {
    status_code: number
    detail: string
    extra?: null | Array<unknown> | Array<unknown>
  }
}

export type V2GetPostsCountError = V2GetPostsCountErrors[keyof V2GetPostsCountErrors]

export interface V2GetPostsCountResponses {
  /**
   * Request fulfilled, document follows
   */
  200: CountPostsResponse
}

export type V2GetPostsCountResponse = V2GetPostsCountResponses[keyof V2GetPostsCountResponses]

export interface V2GetScoreCountData {
  body: ListPostBody
  path?: never
  query?: never
  url: '/v2/posts/count/score'
}

export interface V2GetScoreCountErrors {
  /**
   * Validation Exception
   */
  400: {
    status_code: number
    detail: string
    extra?: null | Array<unknown> | Array<unknown>
  }
}

export type V2GetScoreCountError = V2GetScoreCountErrors[keyof V2GetScoreCountErrors]

export interface V2GetScoreCountResponses {
  /**
   * Document created, URL follows
   */
  201: Array<ScoreCountItem>
}

export type V2GetScoreCountResponse = V2GetScoreCountResponses[keyof V2GetScoreCountResponses]

export interface V2GetSimilarPostsData {
  body?: never
  path: {
    post_id: number
  }
  query?: {
    limit?: number
  }
  url: '/v2/posts/{post_id}/similar'
}

export interface V2GetSimilarPostsErrors {
  /**
   * Validation Exception
   */
  400: {
    status_code: number
    detail: string
    extra?: null | Array<unknown> | Array<unknown>
  }
}

export type V2GetSimilarPostsError = V2GetSimilarPostsErrors[keyof V2GetSimilarPostsErrors]

export interface V2GetSimilarPostsResponses {
  /**
   * Request fulfilled, document follows
   */
  200: Array<ServerPostsPostControllerGetSimilarPostsPostResponseBody>
}

export type V2GetSimilarPostsResponse = V2GetSimilarPostsResponses[keyof V2GetSimilarPostsResponses]

export interface V2GetTagsCountData {
  body: ListPostBody
  path?: never
  query?: never
  url: '/v2/posts/count/rating'
}

export interface V2GetTagsCountErrors {
  /**
   * Validation Exception
   */
  400: {
    status_code: number
    detail: string
    extra?: null | Array<unknown> | Array<unknown>
  }
}

export type V2GetTagsCountError = V2GetTagsCountErrors[keyof V2GetTagsCountErrors]

export interface V2GetTagsCountResponses {
  /**
   * Document created, URL follows
   */
  201: Array<RatingCountItem>
}

export type V2GetTagsCountResponse = V2GetTagsCountResponses[keyof V2GetTagsCountResponses]

export interface V2SearchPostsData {
  body: ListPostBody
  path?: never
  query?: {
    limit?: number
    offset?: number
  }
  url: '/v2/posts/search'
}

export interface V2SearchPostsErrors {
  /**
   * Validation Exception
   */
  400: {
    status_code: number
    detail: string
    extra?: null | Array<unknown> | Array<unknown>
  }
}

export type V2SearchPostsError = V2SearchPostsErrors[keyof V2SearchPostsErrors]

export interface V2SearchPostsResponses {
  /**
   * Request fulfilled, document follows
   */
  200: Array<ServerPostsPostControllerSearchPostsPostResponseBody>
}

export type V2SearchPostsResponse = V2SearchPostsResponses[keyof V2SearchPostsResponses]

export interface V2UpdatePostCaptionData {
  body?: never
  path: {
    post_id: number
  }
  query: {
    caption: string
  }
  url: '/v2/posts/{post_id}/caption'
}

export interface V2UpdatePostCaptionErrors {
  /**
   * Validation Exception
   */
  400: {
    status_code: number
    detail: string
    extra?: null | Array<unknown> | Array<unknown>
  }
}

export type V2UpdatePostCaptionError = V2UpdatePostCaptionErrors[keyof V2UpdatePostCaptionErrors]

export interface V2UpdatePostCaptionResponses {
  /**
   * Request fulfilled, document follows
   */
  200: Post
}

export type V2UpdatePostCaptionResponse = V2UpdatePostCaptionResponses[keyof V2UpdatePostCaptionResponses]

export interface V2UpdatePostRatingData {
  body?: never
  path: {
    post_id: number
  }
  query: {
    rating: number
  }
  url: '/v2/posts/{post_id}/rating'
}

export interface V2UpdatePostRatingErrors {
  /**
   * Validation Exception
   */
  400: {
    status_code: number
    detail: string
    extra?: null | Array<unknown> | Array<unknown>
  }
}

export type V2UpdatePostRatingError = V2UpdatePostRatingErrors[keyof V2UpdatePostRatingErrors]

export interface V2UpdatePostRatingResponses {
  /**
   * Request fulfilled, document follows
   */
  200: Post
}

export type V2UpdatePostRatingResponse = V2UpdatePostRatingResponses[keyof V2UpdatePostRatingResponses]

export interface V2UpdatePostScoreData {
  body: ScoreUpdate
  path: {
    post_id: number
  }
  query?: never
  url: '/v2/posts/{post_id}/score'
}

export interface V2UpdatePostScoreErrors {
  /**
   * Validation Exception
   */
  400: {
    status_code: number
    detail: string
    extra?: null | Array<unknown> | Array<unknown>
  }
}

export type V2UpdatePostScoreError = V2UpdatePostScoreErrors[keyof V2UpdatePostScoreErrors]

export interface V2UpdatePostScoreResponses {
  /**
   * Request fulfilled, document follows
   */
  200: Post
}

export type V2UpdatePostScoreResponse = V2UpdatePostScoreResponses[keyof V2UpdatePostScoreResponses]

export interface ClientOptions {
  baseURL: `${string}://${string}` | (string & {})
}
