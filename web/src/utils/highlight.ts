import type { DirectiveBinding } from 'vue'

const highlightDirective = {
  beforeMount(element: HTMLElement, binding: DirectiveBinding) {
    updateHighlight(element, binding.value)
  },
  updated(element: HTMLElement, binding: DirectiveBinding) {
    updateHighlight(element, binding.value)
  },
}

// 用于处理高亮显示功能
function updateHighlight(element: HTMLElement, keyword: string) {
  // 清理所有现有的高亮标记，并恢复文本
  removeHighlight(element)

  // 如果没有关键字则无需处理
  if (!keyword) {
    return
  }

  const regex = new RegExp(`(${escapeRegExp(keyword)})`, 'gi')
  traverseAndHighlight(element, regex)
}

// 遍历子节点并保留原有的 HTML 结构
function traverseAndHighlight(node: Node, regex: RegExp) {
  if (node.nodeType === Node.TEXT_NODE && node.nodeValue) {
    const parent = node.parentNode as HTMLElement
    if (parent && !parent.classList.contains('highlight')) {
      const parts = node.nodeValue.split(regex)
      const fragment = document.createDocumentFragment()
      for (const part of parts) {
        if (regex.test(part)) {
          const span = document.createElement('span')
          span.className = 'highlight'
          span.textContent = part
          fragment.append(span)
        }
        else {
          fragment.append(document.createTextNode(part))
        }
      }
      if (node.parentNode) {
        node.parentNode.replaceChild(fragment, node)
      }
    }
  }
  else if (node.nodeType === Node.ELEMENT_NODE) {
    for (const child of node.childNodes) traverseAndHighlight(child, regex)
  }
}

// 清理所有现有的高亮标记，并将所有文本节点恢复原状
function removeHighlight(element: HTMLElement) {
  const highlightedElements = element.querySelectorAll('.highlight')
  for (const span of highlightedElements) {
    const parent = span.parentNode
    if (parent) {
      const textNode = document.createTextNode(span.textContent || '')
      span.replaceWith(textNode)
      parent.normalize() // 将相邻文本节点合并
    }
  }
}

// 转义正则表达式的特殊字符
function escapeRegExp(string: string): string {
  return string.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}

export default highlightDirective
