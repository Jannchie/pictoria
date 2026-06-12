import type { Ref } from 'vue'
import type { Waterfall } from 'vue-wf'
import type { PostSimplePublic } from '@/api'
import type { Area } from '@/ui/PSelectArea.vue'
import { computed } from 'vue'
import { useElementOffset } from '@/composables/useElementOffset'
import { selectedPostIdSet, selectingPostIdSet, unselectedPostIdSet } from '@/shared'

interface SelectModifiers {
  shift: boolean
  ctrl: boolean
}

// 松手提交：把临时集合（selecting / unselected）应用到 selectedPostIdSet 后清空。
// 只读写全局共享集合，不依赖某个瀑布流实例，故放在模块作用域。
function onSelectEnd() {
  selectedPostIdSet.value = new Set(
    [...selectedPostIdSet.value, ...selectingPostIdSet.value].filter(
      id => !unselectedPostIdSet.value.has(id),
    ),
  )
  selectingPostIdSet.value = new Set()
  unselectedPostIdSet.value = new Set()
}

// 瀑布流框选的共享选择逻辑。拖拽过程中（onSelectChange）把命中的 id 写入临时
// 集合（selecting / unselected），松手时（onSelectEnd，由 SelectArea 的全局
// pointerup 触发）把临时集合提交进 selectedPostIdSet。瀑布流 (MainSection) 与
// 相似图 (Post.vue + SimilarPosts) 共用同一份，保证 Shift / Ctrl / 拖拽框选行为
// 完全一致。
export function useWaterfallSelection(
  waterfallRef: Ref<InstanceType<typeof Waterfall> | null>,
  posts: Ref<PostSimplePublic[]>,
) {
  const wrapperDom = computed(() => waterfallRef.value?.wrapper)
  const offset = useElementOffset(wrapperDom)
  const layoutData = computed(() => waterfallRef.value?.layoutData)

  function onSelectChange(selectArea: Area, { shift, ctrl }: SelectModifiers) {
    // 拖拽区域过小（基本等于一次点击）时忽略，交给 PostItem 的点击逻辑处理。
    if ((selectArea.right - selectArea.left) < 10 || (selectArea.bottom - selectArea.top) < 10) {
      return
    }

    // layoutData 是 x,y,width,height 的数组，selectArea 是 left,right,top,bottom
    // 的对象。计算两者的交集，得到命中的元素 index → post id。
    const currentSelectingId = new Set<number | undefined>()
    if (layoutData.value) {
      for (const [index, element] of layoutData.value.entries()) {
        const elementLeft = element.x + offset.offsetLeft.value
        const elementRight = element.x + element.width + offset.offsetLeft.value
        const elementTop = element.y + offset.offsetTop.value
        const elementBottom = element.y + element.height + offset.offsetTop.value

        const isIntersecting = !(
          elementLeft > selectArea.right
          || elementRight < selectArea.left
          || elementTop > selectArea.bottom
          || elementBottom < selectArea.top
        )
        const post = posts.value[index]
        if (isIntersecting && post) {
          currentSelectingId.add(post.id)
        }
      }
    }

    if (shift) {
      // 追加选择
      selectingPostIdSet.value = new Set([...selectingPostIdSet.value, ...currentSelectingId])
    }
    else if (ctrl) {
      // 补集选择：已选中的取消，未选中的追加
      for (const postId of currentSelectingId) {
        if (selectedPostIdSet.value.has(postId)) {
          unselectedPostIdSet.value.add(postId)
        }
        else {
          selectingPostIdSet.value.add(postId)
        }
      }
    }
    else {
      selectingPostIdSet.value = currentSelectingId
    }
  }

  return { onSelectChange, onSelectEnd }
}
