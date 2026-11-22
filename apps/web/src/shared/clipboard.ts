import { i18n } from '@/locale'
import { announce } from './announce'

/**
 * 写入剪贴板并播报结果：成功播报 `successMessage`（调用方已翻译，polite），失败统一
 * 播报 `common.copyFailed`（assertive）。返回是否写入成功。
 *
 * 所有「复制 X」都走这里 —— 侧栏复制路径、画廊 / 多选复制路径、标签页复制标签名，
 * 详情面板的复制标签也该迁过来。
 */
export async function copyToClipboard(text: string, successMessage: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
  }
  catch {
    announce(i18n.global.t('common.copyFailed'), 'assertive')
    return false
  }
  announce(successMessage)
  return true
}
