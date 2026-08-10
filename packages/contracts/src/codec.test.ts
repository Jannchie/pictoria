import { describe, expect, it } from 'vitest'
import { decodeVector, encodeVector } from './codec.js'

// 定值向量 —— Python 侧 `worker/codec.py` 的测试钉的是同一组数字和同一个 base64
// 字符串。两边任何一侧改了字节序或编码，这里和那里会同时红。
const FIXTURE = new Float32Array([0, 1, -1, 0.5, -0.5, 3.4028235e38, 1.1754944e-38])
const FIXTURE_B64 = 'AAAAAAAAgD8AAIC/AAAAPwAAAL///39/AACAAA=='

describe('向量编解码', () => {
  it('定值向量的 base64 与 Python 侧逐字符相同', () => {
    expect(encodeVector(FIXTURE)).toBe(FIXTURE_B64)
  })

  it('往返逐位相同', () => {
    expect([...decodeVector(encodeVector(FIXTURE))]).toEqual([...FIXTURE])
  })

  it('1152 维真实尺寸往返', () => {
    const vec = new Float32Array(1152)
    for (let i = 0; i < vec.length; i++) vec[i] = Math.sin(i) / 3
    const back = decodeVector(encodeVector(vec))
    expect(back.length).toBe(1152)
    expect([...back]).toEqual([...vec])
  })

  it('base64 长度是 4/3 的原始字节数，比 JSON 数组小得多', () => {
    const vec = new Float32Array(1152)
    for (let i = 0; i < vec.length; i++) vec[i] = Math.sin(i) / 3
    const b64 = encodeVector(vec).length
    const json = JSON.stringify([...vec]).length
    expect(b64).toBe(6144)
    // 3 倍以上的差距是选 base64 的理由，钉住它免得有人"顺手"改回 JSON 数组
    expect(json / b64).toBeGreaterThan(3)
  })

  it('decodeVector 不受 Buffer 共享池影响', () => {
    // 小 Buffer 来自共享池，byteOffset 不为 0；漏掉 byteOffset 会读到别人的数据
    const a = decodeVector(encodeVector(new Float32Array([1, 2, 3])))
    const b = decodeVector(encodeVector(new Float32Array([4, 5, 6])))
    expect([...a]).toEqual([1, 2, 3])
    expect([...b]).toEqual([4, 5, 6])
  })
})
