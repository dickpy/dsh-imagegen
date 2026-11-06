/** Actual studio preview CSS, with local images carrying four corner markers. */
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { GenerationDurationBadge } from '../src/client/GenerationDurationBadge.tsx'
import css from '../src/client/panel.module.css'
function Fixture(){
  const [count,setCount]=useState(1),[variant,setVariant]=useState(0),[mode,setMode]=useState('文生图')
  const legacy=new URLSearchParams(location.search).has('legacy')
  return <div style={{height:'100dvh',display:'flex',flexDirection:'column',fontFamily:'var(--dsw-font-family)'}}>
    <header style={{height:56,display:'flex',alignItems:'center',gap:20,padding:'0 20px',flexShrink:0}}><strong>DSH · 完整图片预览</strong><select aria-label="模式" value={mode} onChange={event=>setMode(event.target.value)}><option>文生图</option><option>图生图</option></select><select aria-label="图片数量" value={count} onChange={event=>setCount(Number(event.target.value))}>{[1,2,4].map(value=><option key={value} value={value}>{value}</option>)}</select><select aria-label="图片方向" value={variant} onChange={event=>setVariant(Number(event.target.value))}><option value={0}>竖图</option><option value={1}>横图</option><option value={2}>方图</option></select></header>
    <main style={{display:'flex',flex:1,minHeight:0,padding:'0 20px 20px'}}><section className={css.canvas}>
      <div className={css.canvasBody}><div className={css.canvasMeta}>{mode} · 共 {count} 张 · 自动完整显示</div><div className={css.grid} data-count={count} data-result-preview-grid="">{Array.from({length:count},(_,index)=><figure key={`${variant}-${index}`} className={css.imageCard} role="button" tabIndex={0} title="放大预览"><img className={css.image} style={legacy?{objectFit:'cover'}:undefined} src={`/sample/${(index+variant)%3}.png`} alt={`result-${index}`} /><GenerationDurationBadge durationMs={[62345, 125000, 0, undefined][index]} /><figcaption className={css.imageCaption}>参考提示词：四个彩色边角应完整可见，图片保持原始比例</figcaption></figure>)}</div></div>
    </section></main>
  </div>
}
createRoot(document.getElementById('root')!).render(<Fixture/> )
