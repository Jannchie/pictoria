/**
 * 中文文件名不能让 API 进程退出。
 *
 * `content-disposition` 的值是 HTTP header，也就是 latin-1 的 ByteString。把一个
 * 中文文件名直接拼进去，undici 的 `new Headers()` 会抛 TypeError，而图片路由里
 * 没有人接住它 —— 于是浏览一张中文命名的图就让整个进程退出一次。实测代价：一次
 * 跑到 59% 的全库差分仲裁被连带杀掉。
 */
import { describe, expect, it } from 'vitest'
import { contentDisposition } from './images.js'

describe('contentDisposition', () => {
  it('survives a header round-trip for a non-ASCII name', () => {
    // 这一条才是真正的回归测试：不是断言字符串长什么样，而是断言它进得了 Headers。
    expect(() => new Headers({ 'content-disposition': contentDisposition('收藏_01.png') })).not.toThrow()
  })

  it('keeps an ASCII fallback and a UTF-8 encoded name', () => {
    const value = contentDisposition('收藏_01.png')

    expect(value).toContain('filename="___01.png"')
    expect(value).toContain(`filename*=UTF-8''${encodeURIComponent('收藏_01.png')}`)
  })

  it('leaves a plain ASCII name readable', () => {
    expect(contentDisposition('cat.jpg')).toContain('filename="cat.jpg"')
  })

  it('neutralises quotes and backslashes that would break the header', () => {
    // 引号会提前闭合 filename="…"，反斜杠会把后面的引号转义掉。
    // String.raw：这里要的就是一个字面反斜杠，普通字符串字面量里它会被转义规则吃掉。
    const value = contentDisposition(String.raw`a"b\c.png`)

    expect(value).toContain('filename="a_b_c.png"')
    expect(() => new Headers({ 'content-disposition': value })).not.toThrow()
  })
})
