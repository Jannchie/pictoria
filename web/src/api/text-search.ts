import type { Client, Options as ClientOptions, TDataShape } from './client'
import type { PostSimplePublic } from './types.gen'
import { client as _heyApiClient } from './client.gen'

type TextSearchOptions<TData extends TDataShape = TDataShape, ThrowOnError extends boolean = boolean> = ClientOptions<TData, ThrowOnError> & {
  client?: Client
  meta?: Record<string, unknown>
}

interface V2SearchPostsByTextData {
  body: {
    query: string
  }
  path?: never
  query?: {
    limit?: number
  }
  url: '/v2/posts/search/text'
}

interface V2SearchPostsByTextErrors {
  /**
   * Validation Exception
   */
  400: {
    detail: string | Record<string, unknown> | Array<unknown>
    status_code: number
  }
}

interface V2SearchPostsByTextResponses {
  /**
   * Request fulfilled, document follows
   */
  200: Array<PostSimplePublic>
}

export function v2SearchPostsByText<ThrowOnError extends boolean = false>(options: TextSearchOptions<V2SearchPostsByTextData, ThrowOnError>) {
  return (options.client ?? _heyApiClient).post<V2SearchPostsByTextResponses, V2SearchPostsByTextErrors, ThrowOnError>({
    responseType: 'json',
    url: '/v2/posts/search/text',
    ...options,
  })
}
