import { formatRgb } from 'culori'

export function colorNumToHex(color: number) {
  return `#${color.toString(16).padStart(6, '0')}`
}

/**
 * 创建一个带Alpha通道的LAB颜色
 * @param l - L 通道值
 * @param a - a 通道值
 * @param b - b{z} 通道值
 * @param alpha - 透明度 (0-1)
 * @returns RGB 格式的 CSS 字符串，包含透明度
 */
export function labToRgbaString(l: number, a: number, b: number, alpha: number = 1) {
  return formatRgb(`lab(${l} ${a} ${b} / ${alpha})`)
}
