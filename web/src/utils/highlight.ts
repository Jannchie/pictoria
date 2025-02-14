import type { DirectiveBinding } from 'vue'

const highlightDirective = {
  beforeMount(el: HTMLElement, binding: DirectiveBinding) {
    updateHighlight(el, binding.value)
  },
  updated(el: HTMLElement, binding: DirectiveBinding) {
    updateHighlight(el, binding.value)
  },
}

// 用于处理高亮显示功能
function updateHighlight(el: HTMLElement, keyword: string) {
  // 清理所有现有的高亮标记，并恢复文本
  removeHighlight(el)

  // 如果没有关键字则无需处理
  if (!keyword) {
    return
  }

  const regex = new RegExp(`(${escapeRegExp(keyword)})`, 'gi')
  traverseAndHighlight(el, regex)
}

// 遍历子节点并保留原有的 HTML 结构
function traverseAndHighlight(node: Node, regex: RegExp) {
  if (node.nodeType === Node.TEXT_NODE && node.nodeValue) {
    const parent = node.parentNode as HTMLElement
    if (parent && !parent.classList.contains('highlight')) {
      const parts = node.nodeValue.split(regex)
      const fragment = document.createDocumentFragment()
      parts.forEach((part) => {
        if (regex.test(part)) {
          const span = document.createElement('span')
          span.className = 'highlight'
          span.textContent = part
          fragment.appendChild(span)
        }
        else {
          fragment.appendChild(document.createTextNode(part))
        }
      })
      parent.replaceChild(fragment, node)
    }
  }
  else if (node.nodeType === Node.ELEMENT_NODE) {
    Array.from(node.childNodes).forEach(child => traverseAndHighlight(child, regex))
  }
}

// 清理所有现有的高亮标记，并将所有文本节点恢复原状
function removeHighlight(el: HTMLElement) {
  const highlightedElements = el.querySelectorAll('.highlight')
  highlightedElements.forEach((span) => {
    const parent = span.parentNode
    if (parent) {
      const textNode = document.createTextNode(span.textContent || '')
      parent.replaceChild(textNode, span)
      parent.normalize() // 将相邻文本节点合并
    }
  })
}

// 转义正则表达式的特殊字符
function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export default highlightDirective
