/** reactbits.dev "GooeyNav" port (controlled, dependency-free): the active
 *  pill merges with a radial burst of gooey particles through a
 *  blur+contrast filter. The original renders white ink on dark surfaces,
 *  so the palette flips per detected surface to stay readable in the host
 *  theme. */

import { useEffect, useRef, type ReactNode } from 'react'
import { detectLightSurface } from './surface-theme.ts'
import css from './GooeyNav.module.css'

export interface GooeyNavItem {
  key: string
  label: ReactNode
}

const ANIMATION_TIME = 600
const PARTICLE_COUNT = 15
const PARTICLE_DISTANCES = [90, 10]
const PARTICLE_R = 100
const TIME_VARIANCE = 300
const COLORS = [1, 2, 3, 1, 2, 3, 1, 4]

export function GooeyNav(props: {
  items: GooeyNavItem[]
  activeIndex: number
  onSelect: (index: number) => void
  ariaLabel?: string
}): React.JSX.Element {
  const { items, activeIndex, onSelect, ariaLabel } = props
  const containerRef = useRef<HTMLDivElement>(null)
  const navRef = useRef<HTMLUListElement>(null)
  const filterRef = useRef<HTMLSpanElement>(null)
  const textRef = useRef<HTMLSpanElement>(null)
  const burstRef = useRef<(li: HTMLElement) => void>(() => {})
  const timersRef = useRef<number[]>([])
  const activeIndexRef = useRef(activeIndex)
  activeIndexRef.current = activeIndex

  const updateEffectPosition = (element: HTMLElement): void => {
    const container = containerRef.current
    const filter = filterRef.current
    const text = textRef.current
    if (container === null || filter === null || text === null) return
    const containerRect = container.getBoundingClientRect()
    const pos = element.getBoundingClientRect()
    const styles = {
      left: `${pos.x - containerRect.x}px`,
      top: `${pos.y - containerRect.y}px`,
      width: `${pos.width}px`,
      height: `${pos.height}px`,
    }
    Object.assign(filter.style, styles)
    Object.assign(text.style, styles)
    text.textContent = element.textContent
  }

  // One-time setup: the particle burst timers must survive selection changes,
  // so they live outside the activeIndex-driven effect below.
  useEffect(() => {
    const container = containerRef.current
    const filter = filterRef.current
    const text = textRef.current
    if (container === null || filter === null || text === null) return
    container.dataset.theme = detectLightSurface(container) ? 'light' : 'dark'
    let disposed = false
    const noise = (amount: number): number => amount / 2 - Math.random() * amount
    const getXY = (distance: number, pointIndex: number, totalPoints: number): [number, number] => {
      const angle = ((360 + noise(8)) / totalPoints) * pointIndex * (Math.PI / 180)
      return [distance * Math.cos(angle), distance * Math.sin(angle)]
    }
    const makeParticles = (element: HTMLElement): void => {
      const bubbleTime = ANIMATION_TIME * 2 + TIME_VARIANCE
      element.style.setProperty('--time', `${bubbleTime}ms`)
      for (let i = 0; i < PARTICLE_COUNT; i++) {
        const time = ANIMATION_TIME * 2 + noise(TIME_VARIANCE * 2)
        const rotateSeed = noise(PARTICLE_R / 10)
        const start = getXY(PARTICLE_DISTANCES[0] as number, PARTICLE_COUNT - i, PARTICLE_COUNT)
        const end = getXY((PARTICLE_DISTANCES[1] as number) + noise(7), PARTICLE_COUNT - i, PARTICLE_COUNT)
        const scale = 1 + noise(0.2)
        const color = COLORS[Math.floor(Math.random() * COLORS.length)] ?? 1
        const rotate = rotateSeed > 0 ? (rotateSeed + PARTICLE_R / 20) * 10 : (rotateSeed - PARTICLE_R / 20) * 10
        const timer = window.setTimeout(() => {
          if (disposed) return
          const particle = document.createElement('span')
          const point = document.createElement('span')
          particle.className = css.particle
          point.className = css.point
          particle.style.setProperty('--start-x', `${start[0] as number}px`)
          particle.style.setProperty('--start-y', `${start[1] as number}px`)
          particle.style.setProperty('--end-x', `${end[0] as number}px`)
          particle.style.setProperty('--end-y', `${end[1] as number}px`)
          particle.style.setProperty('--time', `${time}ms`)
          particle.style.setProperty('--scale', `${scale}`)
          particle.style.setProperty('--color', `var(--gooey-color-${color}, currentColor)`)
          particle.style.setProperty('--rotate', `${rotate}deg`)
          particle.appendChild(point)
          element.appendChild(particle)
          if (typeof window.requestAnimationFrame === 'function') {
            window.requestAnimationFrame(() => { element.classList.add(css.active) })
          } else {
            element.classList.add(css.active)
          }
          const removeTimer = window.setTimeout(() => { particle.remove() }, time)
          timersRef.current.push(removeTimer)
        }, 30)
        timersRef.current.push(timer)
      }
    }
    burstRef.current = (li: HTMLElement): void => {
      updateEffectPosition(li)
      for (const particle of [...filter.querySelectorAll(`.${css.particle}`)]) particle.remove()
      text.classList.remove(css.active)
      void text.offsetWidth
      text.classList.add(css.active)
      makeParticles(filter)
    }
    const positionActive = (): void => {
      const nav = navRef.current
      const activeLi = nav?.querySelectorAll('li')[activeIndexRef.current]
      if (activeLi) {
        updateEffectPosition(activeLi)
        text.classList.add(css.active)
      }
    }
    positionActive()
    const observer = new ResizeObserver(positionActive)
    observer.observe(container)
    return () => {
      disposed = true
      for (const timer of timersRef.current) window.clearTimeout(timer)
      timersRef.current = []
      observer.disconnect()
    }
  }, [])

  // External selection changes only reposition the pill (no burst); clicks
  // animate through burstRef above.
  useEffect(() => {
    const nav = navRef.current
    const text = textRef.current
    const activeLi = nav?.querySelectorAll('li')[activeIndex]
    if (activeLi) {
      updateEffectPosition(activeLi)
      text?.classList.add(css.active)
    }
  }, [activeIndex])

  return (
    <div className={css.container} ref={containerRef}>
      <svg className={css.gooSvg} aria-hidden="true" focusable="false">
        <defs>
          {/* Alpha-contrast goo: merges the pill and particles without
              crushing their colors the way CSS contrast() would. */}
          <filter id="dsh-gooey-nav-goo" x="-150%" y="-150%" width="400%" height="400%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="6" result="blur" />
            <feColorMatrix in="blur" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 19 -9" />
          </filter>
        </defs>
      </svg>
      <nav aria-label={ariaLabel} role="tablist">
        <ul ref={navRef}>
          {items.map((item, index) => (
            <li key={item.key} className={activeIndex === index ? css.active : undefined}>
              <button
                type="button"
                role="tab"
                aria-selected={activeIndex === index}
                onClick={event => {
                  if (index === activeIndex) return
                  const li = event.currentTarget.closest('li')
                  if (li !== null) burstRef.current(li)
                  onSelect(index)
                }}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <span className={`${css.effect} ${css.effectFilter}`} ref={filterRef} />
      <span className={`${css.effect} ${css.effectText}`} ref={textRef} />
    </div>
  )
}
