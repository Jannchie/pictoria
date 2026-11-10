/**
 * tag 的写：独立 tag 的创建，post ↔ tag 的加 / 摘，以及摘掉最后一个自动标签时的
 * 重新待办信号（`@pictoria/db` 的 `onRepending`）。
 */
import type { BackfillWorker } from '@pictoria/db'
import { onRepending } from '@pictoria/db'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestApp, requestJson, type TestApp } from '../testing/app.js'

let t: TestApp

beforeEach(() => {
  t = createTestApp()
})

afterEach(() => t.close())

function addAutoTag(postId: number, name: string): void {
  t.sqlite.prepare('INSERT INTO tags(name) VALUES(?) ON CONFLICT DO NOTHING').run(name)
  t.sqlite.prepare('INSERT INTO post_has_tag(post_id, tag_name, is_auto) VALUES(?, ?, 1)').run(postId, name)
}

function tagsOn(postId: number): string[] {
  return t.sqlite.prepare<[number], string>('SELECT tag_name FROM post_has_tag WHERE post_id = ? ORDER BY tag_name').pluck().all(postId)
}

describe('POST /v2/tags', () => {
  it('201 + Result；重名 → 409；指向不存在的组 → 422', async () => {
    const created = await requestJson(t.app, '/v2/tags', { method: 'POST', body: { name: '  cat  ' } })
    expect(created).toEqual({ status: 201, body: { msg: "Tag 'cat' created successfully." } })

    const dup = await requestJson(t.app, '/v2/tags', { method: 'POST', body: { name: 'cat' } })
    expect(dup.status).toBe(409)
    expect(dup.body.error).toBe('TagNameExistsError')

    const badGroup = await requestJson(t.app, '/v2/tags', { method: 'POST', body: { name: 'dog', groupId: 9999 } })
    expect(badGroup.status).toBe(422)
    expect(badGroup.body.error).toBe('TagGroupNotFoundError')
  })
})

describe('PUT /v2/posts/{post_id}/tags/{tag_name}', () => {
  it('加上手工标签（isAuto=false），回读详情', async () => {
    const id = t.insertPost('.', 'a', 'png')
    const { status, body } = await requestJson(t.app, `/v2/posts/${id}/tags/cat`, { method: 'PUT' })
    expect(status).toBe(200)
    expect(body.id).toBe(id)
    expect(body.tags).toHaveLength(1)
    expect(body.tags[0]).toMatchObject({ isAuto: false, tagInfo: { name: 'cat' } })
    expect(tagsOn(id)).toEqual(['cat'])
  })

  it('已经在 → 409 TagAlreadyExistsError；post 不存在 → 404', async () => {
    const id = t.insertPost('.', 'a', 'png')
    await t.app.request(`/v2/posts/${id}/tags/cat`, { method: 'PUT' })
    const again = await requestJson(t.app, `/v2/posts/${id}/tags/cat`, { method: 'PUT' })
    expect(again.status).toBe(409)
    expect(again.body.error).toBe('TagAlreadyExistsError')

    const missing = await requestJson(t.app, '/v2/posts/999/tags/cat', { method: 'PUT' })
    expect(missing.status).toBe(404)
    expect(missing.body.error).toBe('PostNotFoundError')
  })
})

describe('DELETE /v2/posts/{post_id}/tags/{tag_name}', () => {
  it('摘掉后回读详情；不在 post 上 → 409 TagNotOnPostError', async () => {
    const id = t.insertPost('.', 'a', 'png')
    await t.app.request(`/v2/posts/${id}/tags/cat`, { method: 'PUT' })

    const { status, body } = await requestJson(t.app, `/v2/posts/${id}/tags/cat`, { method: 'DELETE' })
    expect(status).toBe(200)
    expect(body.tags).toEqual([])

    const again = await requestJson(t.app, `/v2/posts/${id}/tags/cat`, { method: 'DELETE' })
    expect(again.status).toBe(409)
    expect(again.body.error).toBe('TagNotOnPostError')
  })

  it('只有摘掉**最后一个** is_auto 标签时才通知 tagger 重扫；摘手工标签不通知', async () => {
    const id = t.insertPost('.', 'a', 'png')
    addAutoTag(id, 'auto_a')
    addAutoTag(id, 'auto_b')
    await t.app.request(`/v2/posts/${id}/tags/manual`, { method: 'PUT' })

    const signals: BackfillWorker[][] = []
    const off = onRepending(t.sqlite, workers => signals.push([...workers]))
    try {
      expect((await t.app.request(`/v2/posts/${id}/tags/manual`, { method: 'DELETE' })).status).toBe(200)
      expect((await t.app.request(`/v2/posts/${id}/tags/auto_a`, { method: 'DELETE' })).status).toBe(200)
      expect(signals).toEqual([])

      expect((await t.app.request(`/v2/posts/${id}/tags/auto_b`, { method: 'DELETE' })).status).toBe(200)
      expect(signals).toEqual([['tagger']])
    }
    finally {
      off()
    }
  })
})

describe('PATCH /v2/posts/{post_id}/tags/{tag_name}', () => {
  it('自动 → 人工，回读详情；再 PATCH 同值是幂等的；改回自动', async () => {
    const id = t.insertPost('.', 'a', 'png')
    addAutoTag(id, 'cat')
    addAutoTag(id, 'dog')
    const confirm = await requestJson(t.app, `/v2/posts/${id}/tags/cat`, { method: 'PATCH', body: { isAuto: false } })
    expect(confirm.status).toBe(200)
    expect(confirm.body.tags.find((x: any) => x.tagInfo.name === 'cat')).toMatchObject({ isAuto: false })

    const again = await requestJson(t.app, `/v2/posts/${id}/tags/cat`, { method: 'PATCH', body: { isAuto: false } })
    expect(again.status).toBe(200)

    const back = await requestJson(t.app, `/v2/posts/${id}/tags/cat`, { method: 'PATCH', body: { isAuto: true } })
    expect(back.body.tags.find((x: any) => x.tagInfo.name === 'cat')).toMatchObject({ isAuto: true })
  })

  it('不在 post 上 → 409；post 不存在 → 404；缺 isAuto → 400', async () => {
    const id = t.insertPost('.', 'a', 'png')
    const notOn = await requestJson(t.app, `/v2/posts/${id}/tags/cat`, { method: 'PATCH', body: { isAuto: false } })
    expect(notOn.status).toBe(409)
    expect(notOn.body.error).toBe('TagNotOnPostError')
    const missing = await requestJson(t.app, '/v2/posts/999/tags/cat', { method: 'PATCH', body: { isAuto: false } })
    expect(missing.status).toBe(404)
    const bad = await requestJson(t.app, `/v2/posts/${id}/tags/cat`, { method: 'PATCH', body: {} })
    expect(bad.status).toBe(400)
  })
})
