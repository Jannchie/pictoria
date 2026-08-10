const H='http://127.0.0.1:4777', L='http://127.0.0.1:4779'
const req=async(b,m,u,body)=>{const i={method:m};if(body!==undefined){i.headers={'content-type':'application/json'};i.body=JSON.stringify(body)}const r=await fetch(b+u,i);const t=await r.text();let x=null;try{x=t?JSON.parse(t):null}catch{x=t};return{status:r.status,body:x}}
let pass=0; const fails=[]
const cmp=(l,a,b)=>{const x=JSON.stringify(a),y=JSON.stringify(b); if(x===y)pass++; else fails.push({l,x:x.slice(0,240),y:y.slice(0,240)})}

// timeline：多种 limit + 游标翻页 + 非法游标
for (const q of ['', '?limit=1', '?limit=5', '?limit=200', '?limit=0', '?before=bogus', '?before=a|b|c'])
  cmp(`timeline ${q||'(默认)'}`, await req(H,'GET','/v2/annotations/timeline'+q), await req(L,'GET','/v2/annotations/timeline'+q))

// 用第一页的 nextCursor 翻第二页，验证游标语义
const p1 = await req(L,'GET','/v2/annotations/timeline?limit=3')
if (p1.body?.nextCursor) {
  const q = `?limit=3&before=${encodeURIComponent(p1.body.nextCursor)}`
  cmp('timeline 第二页', await req(H,'GET','/v2/annotations/timeline'+q), await req(L,'GET','/v2/annotations/timeline'+q))
}

// ungroup / make-canonical：找一个真有分组的 post，操作后还原
const grouped = await req(L,'GET','/v2/posts/137/group')
if (grouped.body?.length) {
  const memberId = grouped.body[0].id
  // 只比"不存在的 post"这条错误路径 —— 真正改分组会破坏数据，且还原需要重建 canonical 关系
  for (const ep of ['ungroup','make-canonical'])
    cmp(`${ep} 未知 post`, await req(H,'PUT',`/v2/posts/999999999/${ep}`), await req(L,'PUT',`/v2/posts/999999999/${ep}`))
  // make-canonical 对一个**已是 canonical** 的 post 是空操作，安全可测
  for (const ep of ['make-canonical'])
    cmp(`${ep} 已是 canonical（空操作）`, await req(H,'PUT',`/v2/posts/137/${ep}`), await req(L,'PUT',`/v2/posts/137/${ep}`))
  console.log(`（分组成员 ${memberId} 存在，但真正重排会改数据且难还原，只测空操作与错误路径）`)
}

for (const f of fails){console.log(`❌ ${f.l}`);console.log(`   H: ${f.x}`);console.log(`   L: ${f.y}`)}
console.log(`\n${fails.length===0?'✅':'💥'} ${pass} 项一致`)
process.exit(fails.length?1:0)
