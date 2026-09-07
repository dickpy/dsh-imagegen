/** Animated canvas backdrops for the infinite canvas workspace, ported from
 * reactbits.dev backgrounds. They render inside the grid layer, which never
 * receives pointer events, so every listener observes the viewport element. */

import { useEffect, useRef } from 'react'
import css from './canvas-workspace.module.css'

/** Interactive flowmap-style dot field ("fluid distortion"): the pointer's
 *  velocity pushes dots sideways like a fluid; they spring back home when it
 *  moves on, with a barely-visible idle drift keeping the field alive. */
export function FlowBackground(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    // canvas lives inside the grid layer; events must be observed on the
    // viewport container itself (the grid never receives pointer events).
    const layer = canvas?.parentElement
    const viewport = layer?.parentElement
    if (canvas === null || canvas === undefined || viewport === null || viewport === undefined) return
    const ctx = canvas.getContext('2d')
    if (ctx === null) return
    let disposed = false
    const pointer = { x: -1e4, y: -1e4, vx: 0, vy: 0, seen: false }
    const SPACING = 44
    const RADIUS = 120
    let width = 0
    let height = 0
    let points: Array<{ hx: number; hy: number; x: number; y: number; vx: number; vy: number }> = []
    const rebuild = (): void => {
      const rect = viewport.getBoundingClientRect()
      const dpr = Math.max(1, Math.min(2, window.devicePixelRatio ?? 1))
      width = Math.max(1, Math.round(rect.width))
      height = Math.max(1, Math.round(rect.height))
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      points = []
      for (let y = SPACING / 2; y < height; y += SPACING) {
        for (let x = SPACING / 2; x < width; x += SPACING) points.push({ hx: x, hy: y, x, y, vx: 0, vy: 0 })
      }
    }
    rebuild()
    const observer = new ResizeObserver(rebuild)
    observer.observe(viewport)
    const onMove = (event: PointerEvent): void => {
      const rect = viewport.getBoundingClientRect()
      const x = event.clientX - rect.left
      const y = event.clientY - rect.top
      if (pointer.seen) {
        pointer.vx = pointer.vx * 0.6 + (x - pointer.x) * 0.4
        pointer.vy = pointer.vy * 0.6 + (y - pointer.y) * 0.4
      }
      pointer.x = x
      pointer.y = y
      pointer.seen = true
    }
    const onLeave = (): void => { pointer.x = -1e4; pointer.y = -1e4; pointer.vx = 0; pointer.vy = 0 }
    viewport.addEventListener('pointermove', onMove, true)
    viewport.addEventListener('pointerleave', onLeave)
    let frame = 0
    let time = 0
    const tick = (): void => {
      time += 0.016
      const r2 = RADIUS * RADIUS
      for (const p of points) {
        // A barely-visible idle drift keeps the field alive without the pointer.
        p.vx += (p.hx + Math.sin(time * 1.3 + p.hy * 0.055) * 0.5 - p.x) * 0.03
        p.vy += (p.hy + Math.cos(time * 1.1 + p.hx * 0.055) * 0.5 - p.y) * 0.03
        const dx = p.x - pointer.x
        const dy = p.y - pointer.y
        const d2 = dx * dx + dy * dy
        if (d2 < RADIUS * RADIUS && d2 > 0.01) {
          const d = Math.sqrt(d2)
          const force = (1 - d / RADIUS) * 0.9
          p.vx += pointer.vx * force + (dx / d) * force * 2.2
          p.vy += pointer.vy * force + (dy / d) * force * 2.2
        }
        p.vx *= 0.86
        p.vy *= 0.86
        p.x += p.vx
        p.y += p.vy
      }
      ctx.clearRect(0, 0, width, height)
      for (const p of points) {
        const speed = Math.min(4, Math.hypot(p.vx, p.vy))
        ctx.fillStyle = `rgba(96, 125, 255, ${(0.16 + speed * 0.16).toFixed(3)})`
        ctx.beginPath()
        ctx.arc(p.x, p.y, 1.4 + Math.min(1.8, speed * 0.5), 0, Math.PI * 2)
        ctx.fill()
      }
      frame = window.requestAnimationFrame(tick)
    }
    frame = window.requestAnimationFrame(tick)
    return () => {
      disposed = true
      window.cancelAnimationFrame(frame)
      observer.disconnect()
      viewport.removeEventListener('pointermove', onMove)
      viewport.removeEventListener('pointerleave', onLeave)
    }
  }, [])
  return <canvas ref={canvasRef} className={css.flowCanvas} aria-hidden="true" />
}

/** "Liquid ether" background in the reactbits.dev style: a GPU stable-fluids
 *  velocity simulation whose speed is mapped through a three-stop palette
 *  (raw WebGL, no dependencies). Pointer movement stirs the fluid; after a
 *  second of stillness an auto-driven virtual pointer resumes wandering so
 *  the field keeps breathing on its own and blends back to the real pointer
 *  on input. Unlike the original, the auto driver keeps running while the
 *  pointer merely rests inside — on a working canvas it usually does. */
export function LiquidEtherBackground(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    const layer = canvas?.parentElement
    const viewport = layer?.parentElement
    if (canvas === null || canvas === undefined || viewport === null || viewport === undefined) return
    const gl = canvas.getContext('webgl', { alpha: true, antialias: false, depth: false, stencil: false })
    if (gl === null) return

    // Simulation constants mirror the reactbits LiquidEther defaults.
    const MOUSE_FORCE = 20
    const CURSOR_SIZE = 100 // splat radius, in simulation cells
    const DT = 0.014
    const RESOLUTION = 0.5 // simulation grid spans half the CSS size per axis
    const POISSON_ITERATIONS = 32
    const AUTO_SPEED = 0.5 // normalized units per second
    const AUTO_INTENSITY = 2.2
    const AUTO_RESUME_DELAY = 1000
    const AUTO_RAMP = 600
    const TAKEOVER_DURATION = 250
    const PALETTE = ['#5227FF', '#FF9FFC', '#B497CF']

    // Shared fullscreen-quad vertex shader; sim passes shrink the quad by one
    // cell per side so the border clamps (the display pass uses (1, 1)).
    const quadVertex = `
      precision highp float;
      attribute vec3 position;
      uniform vec2 uScale;
      varying vec2 uv;
      void main() {
        vec3 pos = position;
        pos.xy *= uScale;
        uv = vec2(0.5) + pos.xy * 0.5;
        gl_Position = vec4(pos, 1.0);
      }
    `
    // BFECC advection: backtrace, forward-again to measure the error, then
    // sample from the halfway-corrected position.
    const advectionFragment = `
      precision highp float;
      uniform sampler2D uVelocity;
      uniform float uDt;
      uniform vec2 uFboSize;
      varying vec2 uv;
      void main() {
        vec2 ratio = max(uFboSize.x, uFboSize.y) / uFboSize;
        vec2 velOld = texture2D(uVelocity, uv).xy;
        vec2 spotOld = uv - velOld * uDt * ratio;
        vec2 velNew = texture2D(uVelocity, spotOld).xy;
        vec2 spotAgain = spotOld + velNew * uDt * ratio;
        vec2 spotMid = uv - (spotAgain - uv) * 0.5;
        vec2 velMid = texture2D(uVelocity, spotMid).xy;
        vec2 spotOld2 = spotMid - velMid * uDt * ratio;
        gl_FragColor = vec4(texture2D(uVelocity, spotOld2).xy, 0.0, 0.0);
      }
    `
    const divergenceFragment = `
      precision highp float;
      uniform sampler2D uVelocity;
      uniform float uDt;
      uniform vec2 uPx;
      varying vec2 uv;
      void main() {
        float x0 = texture2D(uVelocity, uv - vec2(uPx.x, 0.0)).x;
        float x1 = texture2D(uVelocity, uv + vec2(uPx.x, 0.0)).x;
        float y0 = texture2D(uVelocity, uv - vec2(0.0, uPx.y)).y;
        float y1 = texture2D(uVelocity, uv + vec2(0.0, uPx.y)).y;
        gl_FragColor = vec4((x1 - x0 + y1 - y0) / 2.0 / uDt);
      }
    `
    const poissonFragment = `
      precision highp float;
      uniform sampler2D uPressure;
      uniform sampler2D uDivergence;
      uniform vec2 uPx;
      varying vec2 uv;
      void main() {
        float p0 = texture2D(uPressure, uv + vec2(uPx.x * 2.0, 0.0)).r;
        float p1 = texture2D(uPressure, uv - vec2(uPx.x * 2.0, 0.0)).r;
        float p2 = texture2D(uPressure, uv + vec2(0.0, uPx.y * 2.0)).r;
        float p3 = texture2D(uPressure, uv - vec2(0.0, uPx.y * 2.0)).r;
        float div = texture2D(uDivergence, uv).r;
        gl_FragColor = vec4((p0 + p1 + p2 + p3) / 4.0 - div);
      }
    `
    const pressureFragment = `
      precision highp float;
      uniform sampler2D uPressure;
      uniform sampler2D uVelocity;
      uniform float uDt;
      uniform vec2 uPx;
      varying vec2 uv;
      void main() {
        float p0 = texture2D(uPressure, uv + vec2(uPx.x, 0.0)).r;
        float p1 = texture2D(uPressure, uv - vec2(uPx.x, 0.0)).r;
        float p2 = texture2D(uPressure, uv + vec2(0.0, uPx.y)).r;
        float p3 = texture2D(uPressure, uv - vec2(0.0, uPx.y)).r;
        vec2 gradient = vec2(p0 - p1, p2 - p3) * 0.5;
        gl_FragColor = vec4(texture2D(uVelocity, uv).xy - gradient * uDt, 0.0, 1.0);
      }
    `
    // Splat: quadratic-falloff force bump added on top of the field with
    // additive blending (no texture read — sampling the render target
    // itself is undefined in WebGL).
    const splatFragment = `
      precision highp float;
      uniform vec2 uCenter;
      uniform vec2 uRadius;
      uniform vec2 uForce;
      varying vec2 uv;
      void main() {
        vec2 offset = (uv - uCenter) / uRadius;
        float weight = 1.0 - min(length(offset), 1.0);
        gl_FragColor = vec4(uForce * weight * weight, 0.0, 0.0);
      }
    `
    // Display: speed through the palette. rgb stays <= alpha so the canvas
    // composites correctly with premultiplied alpha.
    const displayFragment = `
      precision highp float;
      uniform sampler2D uVelocity;
      uniform sampler2D uPalette;
      varying vec2 uv;
      void main() {
        float speed = clamp(length(texture2D(uVelocity, uv).xy), 0.0, 1.0);
        vec3 ink = texture2D(uPalette, vec2(speed, 0.5)).rgb;
        gl_FragColor = vec4(ink * speed, speed);
      }
    `

    const createProgram = (fragmentSource: string): { program: WebGLProgram, uniforms: Record<string, WebGLUniformLocation> } => {
      const compile = (type: number, source: string): WebGLShader => {
        const shader = gl.createShader(type)
        if (shader === null) throw new Error('webgl: shader alloc failed')
        gl.shaderSource(shader, source)
        gl.compileShader(shader)
        if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) {
          throw new Error(gl.getShaderInfoLog(shader) ?? 'webgl: shader compile failed')
        }
        return shader
      }
      const program = gl.createProgram()
      if (program === null) throw new Error('webgl: program alloc failed')
      gl.attachShader(program, compile(gl.VERTEX_SHADER, quadVertex))
      gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSource))
      gl.bindAttribLocation(program, 0, 'position')
      gl.linkProgram(program)
      if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) {
        throw new Error(gl.getProgramInfoLog(program) ?? 'webgl: program link failed')
      }
      // Detached + deleted right after linking, so deleting the program frees everything.
      for (const shader of gl.getAttachedShaders(program) ?? []) {
        gl.detachShader(program, shader)
        gl.deleteShader(shader)
      }
      const uniforms: Record<string, WebGLUniformLocation> = {}
      const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number
      for (let index = 0; index < count; index++) {
        const info = gl.getActiveUniform(program, index)
        const location = info !== null ? gl.getUniformLocation(program, info.name) : null
        if (info !== null && location !== null) uniforms[info.name] = location
      }
      return { program, uniforms }
    }
    const createSimTexture = (width: number, height: number, type: number, filter: number): { texture: WebGLTexture, fbo: WebGLFramebuffer, width: number, height: number } => {
      const texture = gl.createTexture()
      if (texture === null) throw new Error('webgl: texture alloc failed')
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, type, null)
      const fbo = gl.createFramebuffer()
      if (fbo === null) throw new Error('webgl: framebuffer alloc failed')
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      return { texture, fbo, width, height }
    }
    // Float textures are required by the solver; prefer a renderable +
    // linearly-filterable format, degrade to nearest, else give up.
    const chooseSimFormat = (): { type: number, filter: number } | null => {
      const halfFloat = gl.getExtension('OES_texture_half_float')
      const halfLinear = gl.getExtension('OES_texture_half_float_linear')
      const fullFloat = gl.getExtension('OES_texture_float')
      const fullLinear = gl.getExtension('OES_texture_float_linear')
      const candidates: Array<{ type: number, filter: number }> = []
      if (halfFloat !== null && halfLinear !== null) candidates.push({ type: halfFloat.HALF_FLOAT_OES, filter: gl.LINEAR })
      if (fullFloat !== null && fullLinear !== null) candidates.push({ type: gl.FLOAT, filter: gl.LINEAR })
      if (halfFloat !== null) candidates.push({ type: halfFloat.HALF_FLOAT_OES, filter: gl.NEAREST })
      if (fullFloat !== null) candidates.push({ type: gl.FLOAT, filter: gl.NEAREST })
      for (const candidate of candidates) {
        const probe = createSimTexture(4, 4, candidate.type, candidate.filter)
        const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        gl.deleteTexture(probe.texture)
        gl.deleteFramebuffer(probe.fbo)
        if (complete) return candidate
      }
      return null
    }
    const simFormat = chooseSimFormat()
    if (simFormat === null) return
    const advectionPass = createProgram(advectionFragment)
    const splatPass = createProgram(splatFragment)
    const divergencePass = createProgram(divergenceFragment)
    const poissonPass = createProgram(poissonFragment)
    const pressurePass = createProgram(pressureFragment)
    const displayPass = createProgram(displayFragment)

    const quadBuffer = gl.createBuffer()
    if (quadBuffer === null) return
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0)

    const paletteTexture = gl.createTexture()
    if (paletteTexture === null) return
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, paletteTexture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    const paletteData = new Uint8Array(PALETTE.length * 4)
    for (const [index, hex] of PALETTE.entries()) {
      paletteData[index * 4 + 0] = parseInt(hex.slice(1, 3), 16)
      paletteData[index * 4 + 1] = parseInt(hex.slice(3, 5), 16)
      paletteData[index * 4 + 2] = parseInt(hex.slice(5, 7), 16)
      paletteData[index * 4 + 3] = 255
    }
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, PALETTE.length, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, paletteData)

    type SimTexture = { texture: WebGLTexture, fbo: WebGLFramebuffer, width: number, height: number }
    let velocities: [SimTexture, SimTexture] | null = null
    let divergenceTex: SimTexture | null = null
    let pressures: [SimTexture, SimTexture] | null = null
    const destroySimTexture = (texture: SimTexture): void => {
      gl.deleteTexture(texture.texture)
      gl.deleteFramebuffer(texture.fbo)
    }
    const resizeCanvas = (): void => {
      const rect = viewport.getBoundingClientRect()
      const dpr = Math.max(1, Math.min(2, window.devicePixelRatio ?? 1))
      canvas.width = Math.max(1, Math.round(rect.width * dpr))
      canvas.height = Math.max(1, Math.round(rect.height * dpr))
      for (const texture of [...(velocities ?? []), ...(divergenceTex !== null ? [divergenceTex] : []), ...(pressures ?? [])]) destroySimTexture(texture)
      velocities = null
      divergenceTex = null
      pressures = null
      if (rect.width < 1 || rect.height < 1) return
      const simWidth = Math.max(1, Math.round(RESOLUTION * rect.width))
      const simHeight = Math.max(1, Math.round(RESOLUTION * rect.height))
      velocities = [createSimTexture(simWidth, simHeight, simFormat.type, simFormat.filter), createSimTexture(simWidth, simHeight, simFormat.type, simFormat.filter)]
      divergenceTex = createSimTexture(simWidth, simHeight, simFormat.type, simFormat.filter)
      pressures = [createSimTexture(simWidth, simHeight, simFormat.type, simFormat.filter), createSimTexture(simWidth, simHeight, simFormat.type, simFormat.filter)]
    }

    const reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
    const pointer = {
      x: 0, y: 0, oldX: 0, oldY: 0, diffX: 0, diffY: 0,
      seen: false, lastInteract: performance.now(),
      autoActive: false, takeover: false, takeoverStart: 0,
      fromX: 0, fromY: 0, toX: 0, toY: 0,
    }
    const auto = { active: false, x: 0, y: 0, targetX: 0, targetY: 0, last: 0, started: 0 }
    const stopAuto = (): void => {
      auto.active = false
      pointer.autoActive = false
    }
    const pickTarget = (): void => {
      const margin = 0.2
      auto.targetX = (Math.random() * 2 - 1) * (1 - margin)
      auto.targetY = (Math.random() * 2 - 1) * (1 - margin)
    }
    const onPointerMove = (event: PointerEvent): void => {
      const rect = viewport.getBoundingClientRect()
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return
      if (rect.width === 0 || rect.height === 0) return
      const x = ((event.clientX - rect.left) / rect.width) * 2 - 1
      const y = -(((event.clientY - rect.top) / rect.height) * 2 - 1)
      pointer.lastInteract = performance.now()
      if (pointer.autoActive && !pointer.takeover) {
        // Blend from the virtual pointer to the real one instead of jumping.
        pointer.takeover = true
        pointer.takeoverStart = performance.now()
        pointer.fromX = pointer.x
        pointer.fromY = pointer.y
        pointer.toX = x
        pointer.toY = y
        pointer.autoActive = false
        return
      }
      if (!pointer.seen) {
        pointer.oldX = x
        pointer.oldY = y
        pointer.seen = true
      }
      pointer.x = x
      pointer.y = y
    }
    const onPointerLeave = (): void => { pointer.seen = false }
    const updateAuto = (now: number): void => {
      if (reducedMotion) return
      if (now - pointer.lastInteract < AUTO_RESUME_DELAY) {
        if (auto.active) stopAuto()
        return
      }
      if (!auto.active) {
        auto.active = true
        auto.x = pointer.x
        auto.y = pointer.y
        auto.last = now
        auto.started = now
        pickTarget()
      }
      pointer.autoActive = true
      let dtSec = (now - auto.last) / 1000
      auto.last = now
      if (dtSec > 0.2) dtSec = 0.016
      const dx = auto.targetX - auto.x
      const dy = auto.targetY - auto.y
      const dist = Math.hypot(dx, dy)
      if (dist < 0.01) {
        pickTarget()
        return
      }
      const t = Math.min(1, (now - auto.started) / AUTO_RAMP)
      const ramp = t * t * (3 - 2 * t)
      const step = Math.min(AUTO_SPEED * dtSec * ramp, dist)
      auto.x += (dx / dist) * step
      auto.y += (dy / dist) * step
      pointer.x = auto.x
      pointer.y = auto.y
    }
    const updatePointer = (now: number): void => {
      if (pointer.takeover) {
        const t = (now - pointer.takeoverStart) / TAKEOVER_DURATION
        if (t >= 1) {
          pointer.takeover = false
          pointer.x = pointer.toX
          pointer.y = pointer.toY
          pointer.oldX = pointer.x
          pointer.oldY = pointer.y
          pointer.diffX = 0
          pointer.diffY = 0
          return
        }
        const k = t * t * (3 - 2 * t)
        pointer.x = pointer.fromX + (pointer.toX - pointer.fromX) * k
        pointer.y = pointer.fromY + (pointer.toY - pointer.fromY) * k
      }
      pointer.diffX = pointer.x - pointer.oldX
      pointer.diffY = pointer.y - pointer.oldY
      pointer.oldX = pointer.x
      pointer.oldY = pointer.y
      if (pointer.autoActive && !pointer.takeover) {
        pointer.diffX *= AUTO_INTENSITY
        pointer.diffY *= AUTO_INTENSITY
      }
    }

    const bindTarget = (target: SimTexture | null): void => {
      if (target === null) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        gl.viewport(0, 0, canvas.width, canvas.height)
      } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo)
        gl.viewport(0, 0, target.width, target.height)
      }
    }
    const bindTexture = (unit: number, texture: WebGLTexture): void => {
      gl.activeTexture(gl.TEXTURE0 + unit)
      gl.bindTexture(gl.TEXTURE_2D, texture)
    }
    const drawQuad = (): void => { gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4) }
    const step = (now: number): void => {
      if (velocities === null || divergenceTex === null || pressures === null) return
      updateAuto(now)
      updatePointer(now)
      const velocity = velocities[0]
      const pxX = 1 / velocity.width
      const pxY = 1 / velocity.height
      const scaleX = 1 - pxX * 2
      const scaleY = 1 - pxY * 2
      // 1. advect the velocity field (velocity[0] -> velocity[1])
      bindTarget(velocities[1])
      gl.useProgram(advectionPass.program)
      gl.uniform2f(advectionPass.uniforms.uScale, scaleX, scaleY)
      bindTexture(0, velocity.texture)
      gl.uniform1i(advectionPass.uniforms.uVelocity, 0)
      gl.uniform1f(advectionPass.uniforms.uDt, DT)
      gl.uniform2f(advectionPass.uniforms.uFboSize, velocity.width, velocity.height)
      drawQuad()
      // 2. inject the pointer force (additive splat into velocity[1])
      if (Math.abs(pointer.diffX) > 1e-5 || Math.abs(pointer.diffY) > 1e-5) {
        const radiusU = CURSOR_SIZE * pxX * 0.5
        const radiusV = CURSOR_SIZE * pxY * 0.5
        const centerX = Math.min(Math.max((pointer.x + 1) / 2, radiusU + pxX), 1 - radiusU - pxX)
        const centerY = Math.min(Math.max((pointer.y + 1) / 2, radiusV + pxY), 1 - radiusV - pxY)
        gl.enable(gl.BLEND)
        gl.blendFunc(gl.ONE, gl.ONE)
        gl.useProgram(splatPass.program)
        gl.uniform2f(splatPass.uniforms.uScale, 1, 1)
        gl.uniform2f(splatPass.uniforms.uCenter, centerX, centerY)
        gl.uniform2f(splatPass.uniforms.uRadius, radiusU, radiusV)
        gl.uniform2f(splatPass.uniforms.uForce, (pointer.diffX / 2) * MOUSE_FORCE, (pointer.diffY / 2) * MOUSE_FORCE)
        drawQuad()
        gl.disable(gl.BLEND)
      }
      // 3. divergence of the advected field
      bindTarget(divergenceTex)
      gl.useProgram(divergencePass.program)
      gl.uniform2f(divergencePass.uniforms.uScale, scaleX, scaleY)
      bindTexture(0, velocities[1].texture)
      gl.uniform1i(divergencePass.uniforms.uVelocity, 0)
      gl.uniform1f(divergencePass.uniforms.uDt, DT)
      gl.uniform2f(divergencePass.uniforms.uPx, pxX, pxY)
      drawQuad()
      // 4. solve pressure with Jacobi iterations (warm start from last frame)
      gl.useProgram(poissonPass.program)
      gl.uniform2f(poissonPass.uniforms.uScale, scaleX, scaleY)
      gl.uniform2f(poissonPass.uniforms.uPx, pxX, pxY)
      bindTexture(1, divergenceTex.texture)
      gl.uniform1i(poissonPass.uniforms.uDivergence, 1)
      let pressureOut = pressures[0]
      for (let iteration = 0; iteration < POISSON_ITERATIONS; iteration++) {
        const source = pressures[iteration % 2]
        pressureOut = pressures[(iteration + 1) % 2]
        bindTarget(pressureOut)
        bindTexture(0, source.texture)
        gl.uniform1i(poissonPass.uniforms.uPressure, 0)
        drawQuad()
      }
      // 5. project: subtract the pressure gradient (velocity[1] -> velocity[0])
      bindTarget(velocities[0])
      gl.useProgram(pressurePass.program)
      gl.uniform2f(pressurePass.uniforms.uScale, scaleX, scaleY)
      bindTexture(0, pressureOut.texture)
      gl.uniform1i(pressurePass.uniforms.uPressure, 0)
      bindTexture(1, velocities[1].texture)
      gl.uniform1i(pressurePass.uniforms.uVelocity, 1)
      gl.uniform1f(pressurePass.uniforms.uDt, DT)
      gl.uniform2f(pressurePass.uniforms.uPx, pxX, pxY)
      drawQuad()
      // 6. display: map speed through the palette
      bindTarget(null)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.useProgram(displayPass.program)
      gl.uniform2f(displayPass.uniforms.uScale, 1, 1)
      bindTexture(0, velocity.texture)
      gl.uniform1i(displayPass.uniforms.uVelocity, 0)
      bindTexture(1, paletteTexture)
      gl.uniform1i(displayPass.uniforms.uPalette, 1)
      drawQuad()
    }
    let frame = window.requestAnimationFrame(function tick() {
      step(performance.now())
      frame = window.requestAnimationFrame(tick)
    })

    resizeCanvas()
    let resizeFrame = 0
    const observer = new ResizeObserver(() => {
      if (resizeFrame !== 0) window.cancelAnimationFrame(resizeFrame)
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = 0
        resizeCanvas()
      })
    })
    observer.observe(viewport)
    viewport.addEventListener('pointermove', onPointerMove, true)
    viewport.addEventListener('pointerleave', onPointerLeave)
    return () => {
      window.cancelAnimationFrame(frame)
      if (resizeFrame !== 0) window.cancelAnimationFrame(resizeFrame)
      observer.disconnect()
      viewport.removeEventListener('pointermove', onPointerMove)
      viewport.removeEventListener('pointerleave', onPointerLeave)
      for (const texture of [...(velocities ?? []), ...(divergenceTex !== null ? [divergenceTex] : []), ...(pressures ?? [])]) destroySimTexture(texture)
      gl.deleteTexture(paletteTexture)
      gl.deleteBuffer(quadBuffer)
      for (const pass of [advectionPass, splatPass, divergencePass, poissonPass, pressurePass, displayPass]) gl.deleteProgram(pass.program)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
  }, [])
  return <canvas ref={canvasRef} className={css.liquidCanvas} aria-hidden="true" />
}

type ShaderFrameState = {
  gl: WebGLRenderingContext
  program: WebGLProgram
  uniforms: Record<string, WebGLUniformLocation>
  time: number
  width: number
  height: number
  dpr: number
  /** True when the surface underneath the grid layer is light, so shaders
   *  should pick their reactbits lightMode (dark ink on white) branch. */
  light: boolean
  /** Smoothed pointer in CSS pixels (origin top-left); `active` eases to 0
   *  when the pointer leaves so effects can fade out instead of jumping. */
  pointer: { x: number; y: number; active: number }
  draw: () => void
}

const SHADER_QUAD_VERTEX = `
  precision highp float;
  attribute vec3 position;
  varying vec2 vUv;
  void main() {
    vUv = position.xy * 0.5 + 0.5;
    gl_Position = vec4(position, 1.0);
  }
`

/** Walk up from the grid layer to the first opaque surface and decide
 *  light vs dark, so the shader backdrops can pick their lightMode ink. */
function detectLightSurface(element: HTMLElement): boolean {
  let node: HTMLElement | null = element
  while (node !== null) {
    const color = getComputedStyle(node).backgroundColor
    const match = color.match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,]+([\d.]+))?\s*\)/)
    if (match !== null) {
      const alpha = match[4] !== undefined ? Number(match[4]) : 1
      if (alpha >= 0.5) {
        const luminance = (0.2126 * Number(match[1]) + 0.7152 * Number(match[2]) + 0.0722 * Number(match[3])) / 255
        return luminance > 0.55
      }
    }
    node = node.parentElement
  }
  return false
}

/** Shared engine for the fullscreen-shader backdrops: compiles one program,
 *  owns the DPR-sized canvas, the rAF loop, viewport resize and smoothed
 *  pointer tracking. `frame` sets uniforms and calls draw(). WebGL2 is
 *  preferred (floating lines needs dynamic-ish GLSL); returns the detected
 *  theme plus a dispose function, or null when WebGL is unavailable. */
function startShaderCanvas(
  canvas: HTMLCanvasElement,
  viewport: HTMLElement,
  fragmentSource: string,
  frame: (state: ShaderFrameState) => void,
): { light: boolean, dispose: () => void } | null {
  const contextAttributes: WebGLContextAttributes = { alpha: true, antialias: false, depth: false, stencil: false }
  const gl = canvas.getContext('webgl2', contextAttributes) ?? canvas.getContext('webgl', contextAttributes)
  if (gl === null) return null
  try {
    const compile = (type: number, source: string): WebGLShader => {
      const shader = gl.createShader(type)
      if (shader === null) throw new Error('webgl: shader alloc failed')
      gl.shaderSource(shader, source)
      gl.compileShader(shader)
      if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) {
        throw new Error(gl.getShaderInfoLog(shader) ?? 'webgl: shader compile failed')
      }
      return shader
    }
    const program = gl.createProgram()
    if (program === null) return null
    gl.attachShader(program, compile(gl.VERTEX_SHADER, SHADER_QUAD_VERTEX))
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSource))
    gl.bindAttribLocation(program, 0, 'position')
    gl.linkProgram(program)
    if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) {
      throw new Error(gl.getProgramInfoLog(program) ?? 'webgl: program link failed')
    }
    // Detached + deleted right after linking, so deleting the program frees everything.
    for (const shader of gl.getAttachedShaders(program) ?? []) {
      gl.detachShader(program, shader)
      gl.deleteShader(shader)
    }
    const uniforms: Record<string, WebGLUniformLocation> = {}
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number
    for (let index = 0; index < count; index++) {
      const info = gl.getActiveUniform(program, index)
      const location = info !== null ? gl.getUniformLocation(program, info.name) : null
      if (info !== null && location !== null) uniforms[info.name] = location
    }
    const quad = gl.createBuffer()
    if (quad === null) return null
    gl.bindBuffer(gl.ARRAY_BUFFER, quad)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0)

    const state: ShaderFrameState = {
      gl, program, uniforms,
      time: 0, width: 1, height: 1, dpr: 1,
      light: detectLightSurface(viewport),
      pointer: { x: 0, y: 0, active: 0 },
      draw: () => { gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4) },
    }
    const pointerTarget = { x: 0, y: 0, active: 0 }
    const resize = (): void => {
      const rect = viewport.getBoundingClientRect()
      const dpr = Math.max(1, Math.min(2, window.devicePixelRatio ?? 1))
      canvas.width = Math.max(1, Math.round(rect.width * dpr))
      canvas.height = Math.max(1, Math.round(rect.height * dpr))
      // Resizing the drawing buffer does NOT update the GL viewport — without
      // this the whole shader renders into the default 300x150 corner.
      gl.viewport(0, 0, canvas.width, canvas.height)
      state.width = canvas.width
      state.height = canvas.height
      state.dpr = dpr
      pointerTarget.x = rect.width / 2
      pointerTarget.y = rect.height / 2
    }
    const onPointerMove = (event: PointerEvent): void => {
      const rect = viewport.getBoundingClientRect()
      pointerTarget.x = event.clientX - rect.left
      pointerTarget.y = event.clientY - rect.top
      pointerTarget.active = 1
    }
    const onPointerLeave = (): void => { pointerTarget.active = 0 }
    const disposeGl = (): void => {
      gl.deleteBuffer(quad)
      gl.deleteProgram(program)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }

    resize()
    if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true) {
      // Static wallpaper: render exactly one frame, no loop and no input. The
      // GL objects stay alive so the presented frame survives on the canvas.
      frame(state)
      gl.deleteBuffer(quad)
      gl.deleteProgram(program)
      return null
    }
    const start = performance.now()
    let frameHandle = 0
    const tick = (): void => {
      state.time = (performance.now() - start) / 1000
      state.pointer.x += (pointerTarget.x - state.pointer.x) * 0.05
      state.pointer.y += (pointerTarget.y - state.pointer.y) * 0.05
      state.pointer.active += (pointerTarget.active - state.pointer.active) * 0.05
      frame(state)
      frameHandle = window.requestAnimationFrame(tick)
    }
    frameHandle = window.requestAnimationFrame(tick)
    const observer = new ResizeObserver(resize)
    observer.observe(viewport)
    viewport.addEventListener('pointermove', onPointerMove, true)
    viewport.addEventListener('pointerleave', onPointerLeave)
    return {
      light: state.light,
      dispose: () => {
        window.cancelAnimationFrame(frameHandle)
        observer.disconnect()
        viewport.removeEventListener('pointermove', onPointerMove)
        viewport.removeEventListener('pointerleave', onPointerLeave)
        disposeGl()
      },
    }
  } catch {
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return null
  }
}

/** reactbits.dev "FloatingLines": three fields of glowing sine waves drawn by
 *  a single fragment shader and screen-blended over the canvas surface; the
 *  pointer bends nearby waves and shifts a slight parallax. */
export function FloatingLinesBackground(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    const layer = canvas?.parentElement
    const viewport = layer?.parentElement
    if (canvas === null || canvas === undefined || viewport === null || viewport === undefined) return
    const fragment = `
      precision highp float;
      uniform float iTime;
      uniform vec3 iResolution;
      uniform vec2 iMouse;
      uniform float bendInfluence;
      uniform vec2 parallaxOffset;
      uniform float uLightMode;
      const vec3 BLACK = vec3(0.0);
      const vec3 PINK = vec3(233.0, 71.0, 245.0) / 255.0;
      const vec3 BLUE = vec3(47.0, 75.0, 162.0) / 255.0;
      // reactbits defaults: three fields of six lines, offsets baked below.
      const vec3 TOP_POS = vec3(10.0, 0.5, -0.4);
      const vec3 MIDDLE_POS = vec3(5.0, 0.0, 0.2);
      const vec3 BOTTOM_POS = vec3(2.0, -0.7, 0.4);
      const float LINE_DISTANCE = 0.05;
      const float BEND_RADIUS = 5.0;
      const float BEND_STRENGTH = -0.5;
      mat2 rotate2(float r) { return mat2(cos(r), sin(r), -sin(r), cos(r)); }
      vec3 backgroundColor(vec2 uv) {
        vec3 col = vec3(0.0);
        float y = sin(uv.x - 0.2) * 0.3 - 0.1;
        float m = uv.y - y;
        col += mix(BLUE, BLACK, smoothstep(0.0, 1.0, abs(m)));
        col += mix(PINK, BLACK, smoothstep(0.0, 1.0, abs(m - 0.8)));
        return col * 0.5;
      }
      float wave(vec2 uv, float offset, vec2 screenUv, vec2 mouseUv) {
        float xMovement = iTime * 0.1;
        float amp = sin(offset + iTime * 0.2) * 0.3;
        float y = sin(uv.x + offset + xMovement) * amp;
        vec2 d = screenUv - mouseUv;
        float influence = exp(-dot(d, d) * BEND_RADIUS);
        y += (mouseUv.y - screenUv.y) * influence * BEND_STRENGTH * bendInfluence;
        float m = uv.y - y;
        return 0.0175 / max(abs(m) + 0.01, 1e-3) + 0.01;
      }
      void main() {
        vec2 baseUv = (2.0 * gl_FragCoord.xy - iResolution.xy) / iResolution.y;
        baseUv.y *= -1.0;
        baseUv += parallaxOffset;
        vec3 col = vec3(0.0);
        vec3 lineCol = backgroundColor(baseUv);
        vec2 mouseUv = (2.0 * iMouse - iResolution.xy) / iResolution.y;
        mouseUv.y *= -1.0;
        for (int i = 0; i < 6; ++i) {
          float fi = float(i);
          vec2 ruv = baseUv * rotate2(BOTTOM_POS.z * log(length(baseUv) + 1.0));
          col += lineCol * wave(ruv + vec2(LINE_DISTANCE * fi + BOTTOM_POS.x, BOTTOM_POS.y), 1.5 + 0.2 * fi, baseUv, mouseUv) * 0.2;
        }
        for (int i = 0; i < 6; ++i) {
          float fi = float(i);
          vec2 ruv = baseUv * rotate2(MIDDLE_POS.z * log(length(baseUv) + 1.0));
          col += lineCol * wave(ruv + vec2(LINE_DISTANCE * fi + MIDDLE_POS.x, MIDDLE_POS.y), 2.0 + 0.15 * fi, baseUv, mouseUv);
        }
        for (int i = 0; i < 6; ++i) {
          float fi = float(i);
          vec2 ruv = baseUv * rotate2(TOP_POS.z * log(length(baseUv) + 1.0));
          ruv.x *= -1.0;
          col += lineCol * wave(ruv + vec2(LINE_DISTANCE * fi + TOP_POS.x, TOP_POS.y), 1.0 + 0.2 * fi, baseUv, mouseUv) * 0.1;
        }
        if (uLightMode > 0.5) {
          vec3 energy = max(col, vec3(0.0));
          float peak = max(energy.r, max(energy.g, energy.b));
          float coverage = smoothstep(0.018, 0.5, peak);
          vec3 chroma = clamp(energy / max(peak, 0.0001), 0.0, 1.0);
          chroma = pow(chroma, vec3(1.35));
          float chromaPeak = max(chroma.r, max(chroma.g, chroma.b));
          chroma /= max(chromaPeak, 0.0001);
          vec3 ink = mix(chroma, clamp(chroma * 0.82, 0.0, 1.0), smoothstep(0.5, 1.0, coverage));
          gl_FragColor = vec4(mix(vec3(1.0), ink, coverage * 0.94), 1.0);
        } else {
          gl_FragColor = vec4(col, 1.0);
        }
      }
    `
    const handle = startShaderCanvas(canvas, viewport, fragment, state => {
      const { gl, uniforms, time, width, height, dpr, pointer } = state
      gl.useProgram(state.program)
      gl.uniform1f(uniforms.iTime, time)
      gl.uniform3f(uniforms.iResolution, width, height, 1)
      // reactbits feeds the pointer in backing-store pixels, y-up.
      gl.uniform2f(uniforms.iMouse, pointer.x * dpr, (height / dpr - pointer.y) * dpr)
      gl.uniform1f(uniforms.bendInfluence, pointer.active)
      gl.uniform2f(
        uniforms.parallaxOffset,
        (pointer.x / Math.max(1, width / dpr) - 0.5) * 0.2,
        -(pointer.y / Math.max(1, height / dpr) - 0.5) * 0.2,
      )
      gl.uniform1f(uniforms.uLightMode, state.light ? 1 : 0)
      state.draw()
    })
    if (handle === null) return
    // The glowing ink only reads correctly over a dark surface; the lightMode
    // branch paints its own light backdrop, so blending must be off there.
    canvas.style.mixBlendMode = handle.light ? 'normal' : 'screen'
    return () => { handle.dispose() }
  }, [])
  return <canvas ref={canvasRef} className={css.sceneCanvas} aria-hidden="true" />
}

/** reactbits.dev "Galaxy": four parallax layers of twinkling stars flying
 *  outward, pushed away from the pointer (single transparent fragment shader). */
export function GalaxyBackground(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    const layer = canvas?.parentElement
    const viewport = layer?.parentElement
    if (canvas === null || canvas === undefined || viewport === null || viewport === undefined) return
    const fragment = `
      precision highp float;
      uniform float uTime;
      uniform vec3 uResolution;
      uniform float uStarSpeed;
      uniform vec2 uMouse;
      uniform float uMouseActiveFactor;
      uniform float uLightMode;
      varying vec2 vUv;
      const float NUM_LAYER = 4.0;
      const float STAR_COLOR_CUTOFF = 0.2;
      const mat2 MAT45 = mat2(0.7071, -0.7071, 0.7071, 0.7071);
      const float PERIOD = 3.0;
      // reactbits Galaxy defaults, baked.
      const vec2 FOCAL = vec2(0.5, 0.5);
      const vec2 ROTATION = vec2(1.0, 0.0);
      const float DENSITY = 1.0;
      const float HUE_SHIFT = 140.0;
      const float SPEED = 1.0;
      const float GLOW = 0.3;
      const float SATURATION = 0.0;
      const float TWINKLE = 0.3;
      const float ROTATION_SPEED = 0.1;
      const float REPULSION = 2.0;
      float Hash21(vec2 p) {
        p = fract(p * vec2(123.34, 456.21));
        p += dot(p, p + 45.32);
        return fract(p.x * p.y);
      }
      float tri(float x) { return abs(fract(x) * 2.0 - 1.0); }
      float tris(float x) {
        float t = fract(x);
        return 1.0 - smoothstep(0.0, 1.0, abs(2.0 * t - 1.0));
      }
      float trisn(float x) {
        float t = fract(x);
        return 2.0 * (1.0 - smoothstep(0.0, 1.0, abs(2.0 * t - 1.0))) - 1.0;
      }
      vec3 hsv2rgb(vec3 c) {
        vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
        vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
        return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
      }
      float Star(vec2 uv, float flare) {
        float d = length(uv);
        float m = (0.05 * GLOW) / d;
        float rays = smoothstep(0.0, 1.0, 1.0 - abs(uv.x * uv.y * 1000.0));
        m += rays * flare * GLOW;
        uv *= MAT45;
        rays = smoothstep(0.0, 1.0, 1.0 - abs(uv.x * uv.y * 1000.0));
        m += rays * 0.3 * flare * GLOW;
        m *= smoothstep(1.0, 0.2, d);
        return m;
      }
      vec3 StarLayer(vec2 uv) {
        vec3 col = vec3(0.0);
        vec2 gv = fract(uv) - 0.5;
        vec2 id = floor(uv);
        for (int y = -1; y <= 1; y++) {
          for (int x = -1; x <= 1; x++) {
            vec2 si = id + vec2(float(x), float(y));
            float seed = Hash21(si);
            float size = fract(seed * 345.32);
            float glossLocal = tri(uStarSpeed / (PERIOD * seed + 1.0));
            float flareSize = smoothstep(0.9, 1.0, size) * glossLocal;
            float red = smoothstep(STAR_COLOR_CUTOFF, 1.0, Hash21(si + 1.0)) + STAR_COLOR_CUTOFF;
            float blu = smoothstep(STAR_COLOR_CUTOFF, 1.0, Hash21(si + 3.0)) + STAR_COLOR_CUTOFF;
            float grn = min(red, blu) * seed;
            vec3 base = vec3(red, grn, blu);
            float hue = atan(base.g - base.r, base.b - base.r) / (2.0 * 3.14159) + 0.5;
            hue = fract(hue + HUE_SHIFT / 360.0);
            float sat = length(base - vec3(dot(base, vec3(0.299, 0.587, 0.114)))) * SATURATION;
            float val = max(max(base.r, base.g), base.b);
            base = hsv2rgb(vec3(hue, sat, val));
            vec2 pad = vec2(tris(seed * 34.0 + uTime * SPEED / 10.0), tris(seed * 38.0 + uTime * SPEED / 30.0)) - 0.5;
            float star = Star(gv - vec2(float(x), float(y)) - pad, flareSize);
            float twinkle = trisn(uTime * SPEED + seed * 6.2831) * 0.5 + 1.0;
            twinkle = mix(1.0, twinkle, TWINKLE);
            star *= twinkle;
            col += star * size * base;
          }
        }
        return col;
      }
      void main() {
        vec2 focalPx = FOCAL * uResolution.xy;
        vec2 uv = (vUv * uResolution.xy - focalPx) / uResolution.y;
        // mouse repulsion (reactbits mouseRepulsion default)
        vec2 mousePosUV = (uMouse * uResolution.xy - focalPx) / uResolution.y;
        float mouseDist = length(uv - mousePosUV);
        vec2 repulsion = normalize(uv - mousePosUV) * (REPULSION / (mouseDist + 0.1));
        uv += repulsion * 0.05 * uMouseActiveFactor;
        float autoRotAngle = uTime * ROTATION_SPEED;
        uv = mat2(cos(autoRotAngle), -sin(autoRotAngle), sin(autoRotAngle), cos(autoRotAngle)) * uv;
        uv = mat2(ROTATION.x, -ROTATION.y, ROTATION.y, ROTATION.x) * uv;
        vec3 col = vec3(0.0);
        for (float i = 0.0; i < 1.0; i += 1.0 / NUM_LAYER) {
          float depth = fract(i + uStarSpeed * SPEED);
          float scale = mix(20.0 * DENSITY, 0.5 * DENSITY, depth);
          float fade = depth * smoothstep(1.0, 0.9, depth);
          col += StarLayer(uv * scale + i * 453.32) * fade;
        }
        // transparent path, premultiplied for the canvas compositor
        if (uLightMode > 0.5) {
          float energy = max(max(col.r, col.g), col.b);
          float coverage = clamp(smoothstep(0.0, 0.42, energy) * 0.92, 0.0, 0.92);
          vec3 ink = clamp(col * 0.48, 0.0, 0.82);
          gl_FragColor = vec4(mix(vec3(1.0), ink, coverage), 1.0);
        } else {
          float alpha = smoothstep(0.0, 0.3, length(col));
          gl_FragColor = vec4(col * alpha, alpha);
        }
      }
    `
    const handle = startShaderCanvas(canvas, viewport, fragment, state => {
      const { gl, uniforms, time, width, height, dpr, pointer } = state
      gl.useProgram(state.program)
      gl.uniform1f(uniforms.uTime, time)
      gl.uniform3f(uniforms.uResolution, width, height, width / Math.max(1, height))
      // reactbits: uStarSpeed = (elapsedSeconds * starSpeed) / 10 with starSpeed 0.5
      gl.uniform1f(uniforms.uStarSpeed, time * 0.05)
      gl.uniform2f(
        uniforms.uMouse,
        pointer.x / Math.max(1, width / dpr),
        1 - pointer.y / Math.max(1, height / dpr),
      )
      gl.uniform1f(uniforms.uMouseActiveFactor, pointer.active)
      gl.uniform1f(uniforms.uLightMode, state.light ? 1 : 0)
      state.draw()
    })
    if (handle === null) return
    return () => { handle.dispose() }
  }, [])
  return <canvas ref={canvasRef} className={css.sceneCanvas} aria-hidden="true" />
}

/** reactbits.dev "Silk": slow flowing fabric sheen (single opaque fragment
 *  shader in the reactbits default #7B7481 mauve). */
export function SilkBackground(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    const layer = canvas?.parentElement
    const viewport = layer?.parentElement
    if (canvas === null || canvas === undefined || viewport === null || viewport === undefined) return
    const fragment = `
      precision highp float;
      varying vec2 vUv;
      uniform float uTime;
      uniform float uLightMode;
      const vec3 COLOR = vec3(123.0, 116.0, 129.0) / 255.0; // reactbits default #7B7481
      const float e = 2.71828182845904523536;
      float noise(vec2 texCoord) {
        vec2 r = e * sin(e * texCoord);
        return fract(r.x * r.y * (1.0 + texCoord.x));
      }
      void main() {
        float rnd = noise(gl_FragCoord.xy);
        vec2 tex = vUv;
        float tOffset = 5.0 * uTime;
        tex.y += 0.03 * sin(8.0 * tex.x - tOffset);
        float pattern = 0.6 +
          0.4 * sin(5.0 * (tex.x + tex.y +
                           cos(3.0 * tex.x + 5.0 * tex.y) +
                           0.02 * tOffset) +
                    sin(20.0 * (tex.x + tex.y - 0.1 * tOffset)));
        float grain = rnd / 15.0 * 1.5;
        vec3 result = COLOR * pattern - vec3(grain);
        if (uLightMode > 0.5) {
          float fold = smoothstep(0.28, 0.9, pattern);
          float specular = smoothstep(0.72, 0.98, pattern);
          vec3 lightBase = mix(COLOR * 0.72, min(COLOR * 1.18, vec3(1.0)), fold);
          lightBase = mix(lightBase, vec3(1.0), specular * 0.92);
          float fineNoise = noise(gl_FragCoord.xy * 0.63 + vec2(17.0, 41.0));
          result = lightBase + (rnd + fineNoise - 1.0) * clamp(1.5 * 0.038, 0.0, 0.16);
        }
        gl_FragColor = vec4(clamp(result, 0.0, 1.0), 1.0);
      }
    `
    const handle = startShaderCanvas(canvas, viewport, fragment, state => {
      const { gl, uniforms, time } = state
      gl.useProgram(state.program)
      // reactbits advances uTime by 0.1 per real second.
      gl.uniform1f(uniforms.uTime, time * 0.1)
      gl.uniform1f(uniforms.uLightMode, state.light ? 1 : 0)
      state.draw()
    })
    if (handle === null) return
    return () => { handle.dispose() }
  }, [])
  return <canvas ref={canvasRef} className={css.sceneCanvas} aria-hidden="true" />
}

/** reactbits.dev "Waves": vertical perlin-noise wave lines that spring away
 *  from the pointer (canvas 2D port; strokes follow the theme label color). */
export function WavesBackground(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    const layer = canvas?.parentElement
    const viewport = layer?.parentElement
    if (canvas === null || canvas === undefined || viewport === null || viewport === undefined) return
    const ctx = canvas.getContext('2d')
    if (ctx === null) return

    // Compact classic 2D Perlin (the reactbits Waves Noise class).
    const GRAD3 = [[1, 1], [-1, 1], [1, -1], [-1, -1], [1, 0], [-1, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [0, 1], [0, -1]]
    const PERM_TABLE = [
      151, 160, 137, 91, 90, 15, 131, 13, 201, 95, 96, 53, 194, 233, 7, 225, 140, 36, 103, 30, 69, 142, 8, 99, 37, 240,
      21, 10, 23, 190, 6, 148, 247, 120, 234, 75, 0, 26, 197, 62, 94, 252, 219, 203, 117, 35, 11, 32, 57, 177, 33, 88,
      237, 149, 56, 87, 174, 20, 125, 136, 171, 168, 68, 175, 74, 165, 71, 134, 139, 48, 27, 166, 77, 146, 158, 231, 83,
      111, 229, 122, 60, 211, 133, 230, 220, 105, 92, 41, 55, 46, 245, 40, 244, 102, 143, 54, 65, 25, 63, 161, 1, 216,
      80, 73, 209, 76, 132, 187, 208, 89, 18, 169, 200, 196, 135, 130, 116, 188, 159, 86, 164, 100, 109, 198, 173, 186,
      3, 64, 52, 217, 226, 250, 124, 123, 5, 202, 38, 147, 118, 126, 255, 82, 85, 212, 207, 206, 59, 227, 47, 16, 58,
      17, 182, 189, 28, 42, 223, 183, 170, 213, 119, 248, 152, 2, 44, 154, 163, 70, 221, 153, 101, 155, 167, 43, 172, 9,
      129, 22, 39, 253, 19, 98, 108, 110, 79, 113, 224, 232, 178, 185, 112, 104, 218, 246, 97, 228, 251, 34, 242, 193,
      238, 210, 144, 12, 191, 179, 162, 241, 81, 51, 145, 235, 249, 14, 239, 107, 49, 192, 214, 31, 181, 199, 106, 157,
      184, 84, 204, 176, 115, 121, 50, 45, 127, 4, 150, 254, 138, 236, 205, 93, 222, 114, 67, 29, 24, 72, 243, 141, 128,
      195, 78, 66, 215, 61, 156, 180,
    ]
    const perm = new Int32Array(512)
    const permShift = Math.floor(Math.random() * 256)
    for (let i = 0; i < 512; i++) perm[i] = PERM_TABLE[(i + permShift) & 255] as number
    const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10)
    const mixNum = (a: number, b: number, t: number): number => (1 - t) * a + t * b
    const gradDot = (hash: number, x: number, y: number): number => {
      const g = GRAD3[hash % 12] as number[]
      return g[0] * x + g[1] * y
    }
    const perlin2 = (x: number, y: number): number => {
      let xi = Math.floor(x)
      let yi = Math.floor(y)
      x -= xi
      y -= yi
      xi &= 255
      yi &= 255
      const n00 = gradDot(perm[xi + perm[yi]] as number, x, y)
      const n01 = gradDot(perm[xi + perm[yi + 1]] as number, x, y - 1)
      const n10 = gradDot(perm[xi + 1 + perm[yi]] as number, x - 1, y)
      const n11 = gradDot(perm[xi + 1 + perm[yi + 1]] as number, x - 1, y - 1)
      const u = fade(x)
      return mixNum(mixNum(n00, n10, u), mixNum(n01, n11, u), fade(y))
    }

    const WAVE = { speedX: 0.0125, speedY: 0.005, ampX: 32, ampY: 16, xGap: 10, yGap: 32, friction: 0.925, tension: 0.005, maxMove: 100 }
    type WavePoint = { x: number, y: number, wx: number, wy: number, cx: number, cy: number, vx: number, vy: number }
    let lines: WavePoint[][] = []
    let width = 0
    let height = 0
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio ?? 1))
    const rebuild = (): void => {
      const rect = viewport.getBoundingClientRect()
      width = Math.max(1, Math.round(rect.width))
      height = Math.max(1, Math.round(rect.height))
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      lines = []
      const totalLines = Math.ceil((width + 200) / WAVE.xGap)
      const totalPoints = Math.ceil((height + 30) / WAVE.yGap)
      const xStart = (width - WAVE.xGap * totalLines) / 2
      const yStart = (height - WAVE.yGap * totalPoints) / 2
      for (let i = 0; i <= totalLines; i++) {
        const points: WavePoint[] = []
        for (let j = 0; j <= totalPoints; j++) {
          points.push({ x: xStart + WAVE.xGap * i, y: yStart + WAVE.yGap * j, wx: 0, wy: 0, cx: 0, cy: 0, vx: 0, vy: 0 })
        }
        lines.push(points)
      }
    }
    // Stroke follows the theme label color at the dots pattern's 35% strength.
    const lineColor = getComputedStyle(viewport).getPropertyValue('--dsw-alias-label-primary').trim() || '#94a3b8'

    const mouse = { x: -10, y: 0, sx: 0, sy: 0, lx: 0, ly: 0, vs: 0, angle: 0, set: false }
    const onPointerMove = (event: PointerEvent): void => {
      const rect = viewport.getBoundingClientRect()
      mouse.x = event.clientX - rect.left
      mouse.y = event.clientY - rect.top
      if (!mouse.set) {
        mouse.sx = mouse.x
        mouse.sy = mouse.y
        mouse.lx = mouse.x
        mouse.ly = mouse.y
        mouse.set = true
      }
    }
    const movePoints = (time: number): void => {
      for (const points of lines) {
        for (const point of points) {
          const move = perlin2((point.x + time * WAVE.speedX) * 0.002, (point.y + time * WAVE.speedY) * 0.0015) * 12
          point.wx = Math.cos(move) * WAVE.ampX
          point.wy = Math.sin(move) * WAVE.ampY
          const dx = point.x - mouse.sx
          const dy = point.y - mouse.sy
          const dist = Math.hypot(dx, dy)
          const l = Math.max(175, mouse.vs)
          if (dist < l) {
            const s = 1 - dist / l
            const f = Math.cos(dist * 0.001) * s
            point.vx += Math.cos(mouse.angle) * f * l * mouse.vs * 0.00065
            point.vy += Math.sin(mouse.angle) * f * l * mouse.vs * 0.00065
          }
          point.vx += (0 - point.cx) * WAVE.tension
          point.vy += (0 - point.cy) * WAVE.tension
          point.vx *= WAVE.friction
          point.vy *= WAVE.friction
          point.cx += point.vx * 2
          point.cy += point.vy * 2
          point.cx = Math.min(WAVE.maxMove, Math.max(-WAVE.maxMove, point.cx))
          point.cy = Math.min(WAVE.maxMove, Math.max(-WAVE.maxMove, point.cy))
        }
      }
    }
    const draw = (): void => {
      ctx.clearRect(0, 0, width, height)
      ctx.beginPath()
      ctx.strokeStyle = lineColor
      ctx.lineWidth = 1
      ctx.globalAlpha = 0.35
      for (const points of lines) {
        const first = points[0]
        if (first === undefined) continue
        ctx.moveTo(first.x + first.wx, first.y + first.wy)
        for (let idx = 0; idx < points.length; idx++) {
          const point = points[idx] as WavePoint
          const isLast = idx === points.length - 1
          // The original drops the cursor offset on each line's last point.
          const cursor = isLast ? 0 : point.cx
          const cursorY = isLast ? 0 : point.cy
          ctx.lineTo(point.x + point.wx + cursor, point.y + point.wy + cursorY)
        }
      }
      ctx.stroke()
      ctx.globalAlpha = 1
    }
    const tick = (time: number): void => {
      mouse.sx += (mouse.x - mouse.sx) * 0.1
      mouse.sy += (mouse.y - mouse.sy) * 0.1
      const dx = mouse.x - mouse.lx
      const dy = mouse.y - mouse.ly
      mouse.vs += (Math.hypot(dx, dy) - mouse.vs) * 0.1
      mouse.vs = Math.min(100, mouse.vs)
      mouse.lx = mouse.x
      mouse.ly = mouse.y
      mouse.angle = Math.atan2(dy, dx)
      movePoints(time)
      draw()
      frame = window.requestAnimationFrame(tick)
    }

    rebuild()
    let frame = 0
    if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true) {
      movePoints(0)
      draw()
    } else {
      frame = window.requestAnimationFrame(tick)
      viewport.addEventListener('pointermove', onPointerMove, true)
    }
    const observer = new ResizeObserver(rebuild)
    observer.observe(viewport)
    return () => {
      window.cancelAnimationFrame(frame)
      observer.disconnect()
      viewport.removeEventListener('pointermove', onPointerMove)
    }
  }, [])
  return <canvas ref={canvasRef} className={css.sceneCanvas} aria-hidden="true" />
}

/** reactbits.dev "FaultyTerminal": a glowing CRT terminal of random digits
 *  with scanlines, glitch displacement and flicker; the pointer ripples the
 *  character grid (single opaque fragment shader). */
export function FaultyTerminalBackground(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    const layer = canvas?.parentElement
    const viewport = layer?.parentElement
    if (canvas === null || canvas === undefined || viewport === null || viewport === undefined) return
    const fragment = `
      precision mediump float;
      varying vec2 vUv;
      uniform float iTime;
      uniform vec3 iResolution;
      uniform vec2 uMouse;
      uniform float uPageLoadProgress;
      uniform float uLightMode;
      // reactbits FaultyTerminal defaults, baked (timeScale 0.3 folded in below).
      const float TIME_SCALE = 0.333333;
      const float SCALE = 1.0;
      const vec2 GRID_MUL = vec2(2.0, 1.0);
      const float DIGIT_SIZE = 1.5;
      const float SCANLINE = 0.3;
      const float FLICKER = 1.0;
      const float NOISE_AMP = 1.0;
      const float CURVATURE = 0.2;
      const float MOUSE_STRENGTH = 0.2;
      float time;
      float hash21(vec2 p) {
        p = fract(p * 234.56);
        p += dot(p, p + 34.56);
        return fract(p.x * p.y);
      }
      float noise(vec2 p) {
        return sin(p.x * 10.0) * sin(p.y * (3.0 + sin(time * 0.090909))) + 0.2;
      }
      mat2 rotate(float angle) {
        float c = cos(angle);
        float s = sin(angle);
        return mat2(c, -s, s, c);
      }
      float fbm(vec2 p) {
        p *= 1.1;
        float f = 0.0;
        float amp = 0.5 * NOISE_AMP;
        mat2 modify0 = rotate(time * 0.02);
        f += amp * noise(p);
        p = modify0 * p * 2.0;
        amp *= 0.454545;
        mat2 modify1 = rotate(time * 0.02);
        f += amp * noise(p);
        p = modify1 * p * 2.0;
        amp *= 0.454545;
        mat2 modify2 = rotate(time * 0.08);
        f += amp * noise(p);
        return f;
      }
      float pattern(vec2 p, out vec2 q, out vec2 r) {
        vec2 offset1 = vec2(1.0);
        vec2 offset0 = vec2(0.0);
        mat2 rot01 = rotate(0.1 * time);
        mat2 rot1 = rotate(0.1);
        q = vec2(fbm(p + offset1), fbm(rot01 * p + offset1));
        r = vec2(fbm(rot1 * q + offset0), fbm(q + offset0));
        return fbm(p + r);
      }
      float digit(vec2 p) {
        vec2 grid = GRID_MUL * 15.0;
        vec2 s = floor(p * grid) / grid;
        p = p * grid;
        vec2 q, r;
        float intensity = pattern(s * 0.1, q, r) * 1.3 - 0.03;
        vec2 mouseWorld = uMouse * SCALE;
        float distToMouse = distance(s, mouseWorld);
        float mouseInfluence = exp(-distToMouse * 8.0) * MOUSE_STRENGTH * 10.0;
        intensity += mouseInfluence;
        float ripple = sin(distToMouse * 20.0 - iTime * 5.0) * 0.1 * mouseInfluence;
        intensity += ripple;
        float cellRandom = fract(sin(dot(s, vec2(12.9898, 78.233))) * 43758.5453);
        float cellDelay = cellRandom * 0.8;
        float cellProgress = clamp((uPageLoadProgress - cellDelay) / 0.2, 0.0, 1.0);
        intensity *= smoothstep(0.0, 1.0, cellProgress);
        p = fract(p);
        p *= DIGIT_SIZE;
        float px5 = p.x * 5.0;
        float py5 = (1.0 - p.y) * 5.0;
        float x = fract(px5);
        float y = fract(py5);
        float i = floor(py5) - 2.0;
        float j = floor(px5) - 2.0;
        float n = i * i + j * j;
        float f = n * 0.0625;
        float isOn = step(0.1, intensity - f);
        float brightness = isOn * (0.2 + y * 0.8) * (0.75 + x * 0.25);
        return step(0.0, p.x) * step(p.x, 1.0) * step(0.0, p.y) * step(p.y, 1.0) * brightness;
      }
      float onOff(float a, float b, float c) {
        return step(c, sin(iTime + a * cos(iTime * b))) * FLICKER;
      }
      float displace(vec2 look) {
        float y = look.y - mod(iTime * 0.25, 1.0);
        float window = 1.0 / (1.0 + 50.0 * y * y);
        return sin(look.y * 20.0 + iTime) * 0.0125 * onOff(4.0, 2.0, 0.8) * (1.0 + cos(iTime * 60.0)) * window;
      }
      vec3 getColor(vec2 p) {
        float bar = step(mod(p.y + time * 20.0, 1.0), 0.2) * 0.4 + 1.0;
        bar *= SCANLINE;
        float displacement = displace(p);
        p.x += displacement;
        float middle = digit(p);
        const float off = 0.002;
        float sum = digit(p + vec2(-off, -off)) + digit(p + vec2(0.0, -off)) + digit(p + vec2(off, -off)) +
                    digit(p + vec2(-off, 0.0)) + digit(p + vec2(0.0, 0.0)) + digit(p + vec2(off, 0.0)) +
                    digit(p + vec2(-off, off)) + digit(p + vec2(0.0, off)) + digit(p + vec2(off, off));
        return vec3(0.9) * middle + sum * 0.1 * vec3(1.0) * bar;
      }
      vec2 barrel(vec2 uv) {
        vec2 c = uv * 2.0 - 1.0;
        c *= 1.0 + CURVATURE * dot(c, c);
        return c * 0.5 + 0.5;
      }
      void main() {
        time = iTime * TIME_SCALE;
        vec2 p = barrel(vUv) * SCALE;
        vec3 col = getColor(p);
        if (uLightMode > 0.5) {
          float energy = max(max(col.r, col.g), col.b);
          float coverage = clamp(smoothstep(0.0, 0.72, energy) * 0.9, 0.0, 0.9);
          vec3 ink = clamp(col * 0.42, 0.0, 0.76);
          col = mix(vec3(1.0), ink, coverage);
        }
        gl_FragColor = vec4(col, 1.0);
      }
    `
    // The original randomizes the start of the terminal clock per mount.
    const timeOffset = Math.random() * 100
    const handle = startShaderCanvas(canvas, viewport, fragment, state => {
      const { gl, uniforms, time, width, height, dpr, pointer } = state
      gl.useProgram(state.program)
      gl.uniform1f(uniforms.iTime, (time + timeOffset) * 0.3)
      gl.uniform3f(uniforms.iResolution, width, height, width / Math.max(1, height))
      gl.uniform2f(
        uniforms.uMouse,
        pointer.x / Math.max(1, width / dpr),
        1 - pointer.y / Math.max(1, height / dpr),
      )
      // reactbits fades the character cells in over 2s on mount.
      gl.uniform1f(uniforms.uPageLoadProgress, Math.min(1, time / 2))
      gl.uniform1f(uniforms.uLightMode, state.light ? 1 : 0)
      state.draw()
    })
    if (handle === null) return
    return () => { handle.dispose() }
  }, [])
  return <canvas ref={canvasRef} className={css.sceneCanvas} aria-hidden="true" />
}

/** reactbits.dev "DotField": a purple dot lattice that bulges away from the
 *  pointer as it moves, springing back home, with a soft glow under the
 *  cursor while the field is engaged (canvas 2D). */
export function DotFieldBackground(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    const layer = canvas?.parentElement
    const viewport = layer?.parentElement
    if (canvas === null || canvas === undefined || viewport === null || viewport === undefined) return
    const ctx = canvas.getContext('2d', { alpha: true })
    if (ctx === null) return
    const FIELD = { radius: 1.5, spacing: 14, cursorRadius: 500, bulgeStrength: 67, glowRadius: 160 }
    const light = detectLightSurface(viewport)
    const glowInner = light ? 'rgba(82, 39, 255, 0.16)' : 'rgba(18, 15, 23, 1)'
    const glowOuter = light ? 'rgba(82, 39, 255, 0)' : 'rgba(18, 15, 23, 0)'
    type FieldDot = { ax: number, ay: number, sx: number, sy: number }
    let dots: FieldDot[] = []
    let width = 0
    let height = 0
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio ?? 1))
    const rebuild = (): void => {
      const rect = viewport.getBoundingClientRect()
      width = Math.max(1, Math.round(rect.width))
      height = Math.max(1, Math.round(rect.height))
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const step = FIELD.radius + FIELD.spacing
      const cols = Math.floor(width / step)
      const rows = Math.floor(height / step)
      const padX = (width % step) / 2
      const padY = (height % step) / 2
      dots = []
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const ax = padX + col * step + step / 2
          const ay = padY + row * step + step / 2
          dots.push({ ax, ay, sx: ax, sy: ay })
        }
      }
    }
    const mouse = { x: -9999, y: -9999, prevX: -9999, prevY: -9999, speed: 0, seen: false }
    const onPointerMove = (event: PointerEvent): void => {
      const rect = viewport.getBoundingClientRect()
      mouse.x = event.clientX - rect.left
      mouse.y = event.clientY - rect.top
      if (!mouse.seen) {
        mouse.prevX = mouse.x
        mouse.prevY = mouse.y
        mouse.seen = true
      }
    }
    let engagement = 0
    let glowOpacity = 0
    const draw = (frameCount: number): void => {
      const dx = mouse.prevX - mouse.x
      const dy = mouse.prevY - mouse.y
      mouse.speed += (Math.hypot(dx, dy) - mouse.speed) * 0.5
      if (mouse.speed < 0.001) mouse.speed = 0
      mouse.prevX = mouse.x
      mouse.prevY = mouse.y
      const target = Math.min(mouse.speed / 5, 1)
      engagement += (target - engagement) * 0.06
      if (engagement < 0.001) engagement = 0
      glowOpacity += (engagement - glowOpacity) * 0.08

      ctx.clearRect(0, 0, width, height)
      if (glowOpacity > 0.01 && mouse.seen) {
        const glow = ctx.createRadialGradient(mouse.x, mouse.y, 0, mouse.x, mouse.y, FIELD.glowRadius)
        glow.addColorStop(0, glowInner)
        glow.addColorStop(1, glowOuter)
        ctx.globalAlpha = glowOpacity
        ctx.fillStyle = glow
        ctx.beginPath()
        ctx.arc(mouse.x, mouse.y, FIELD.glowRadius, 0, Math.PI * 2)
        ctx.fill()
        ctx.globalAlpha = 1
      }
      const gradient = ctx.createLinearGradient(0, 0, width, height)
      gradient.addColorStop(0, 'rgba(168, 85, 247, 0.35)')
      gradient.addColorStop(1, 'rgba(180, 151, 207, 0.25)')
      ctx.fillStyle = gradient

      const crSq = FIELD.cursorRadius * FIELD.cursorRadius
      const rad = FIELD.radius / 2
      ctx.beginPath()
      for (const dot of dots) {
        const dxDot = mouse.x - dot.ax
        const dyDot = mouse.y - dot.ay
        const distSq = dxDot * dxDot + dyDot * dyDot
        if (distSq < crSq && engagement > 0.01) {
          const dist = Math.sqrt(distSq)
          const t = 1 - dist / FIELD.cursorRadius
          const push = t * t * FIELD.bulgeStrength * engagement
          const angle = Math.atan2(dyDot, dxDot)
          dot.sx += (dot.ax - Math.cos(angle) * push - dot.sx) * 0.15
          dot.sy += (dot.ay - Math.sin(angle) * push - dot.sy) * 0.15
        } else {
          dot.sx += (dot.ax - dot.sx) * 0.1
          dot.sy += (dot.ay - dot.sy) * 0.1
        }
        ctx.moveTo(dot.sx + rad, dot.sy)
        ctx.arc(dot.sx, dot.sy, rad, 0, Math.PI * 2)
      }
      ctx.fill()
      frame = window.requestAnimationFrame(tick)
    }
    const tick = (): void => { draw(performance.now()) }

    rebuild()
    let frame = 0
    if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true) {
      draw(0)
    } else {
      frame = window.requestAnimationFrame(tick)
      viewport.addEventListener('pointermove', onPointerMove, true)
    }
    const observer = new ResizeObserver(rebuild)
    observer.observe(viewport)
    return () => {
      window.cancelAnimationFrame(frame)
      observer.disconnect()
      viewport.removeEventListener('pointermove', onPointerMove)
    }
  }, [])
  return <canvas ref={canvasRef} className={css.sceneCanvas} aria-hidden="true" />
}

/** reactbits.dev "DotGrid": a chunky dot lattice (reactbits default #5227FF)
 *  that reacts to fast pointer strokes and clicks with inertia shockwaves —
 *  dots fly out and elastically spring back (canvas 2D, spring port of the
 *  original's gsap inertia tweens). */
export function DotGridBackground(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    const layer = canvas?.parentElement
    const viewport = layer?.parentElement
    if (canvas === null || canvas === undefined || viewport === null || viewport === undefined) return
    const ctx = canvas.getContext('2d')
    if (ctx === null) return
    const GRID = { dotSize: 16, gap: 32, color: '#5227FF', proximity: 150, speedTrigger: 100, shockRadius: 250, shockStrength: 5 }
    // Elastic return, standing in for the original's gsap InertiaPlugin.
    const omega = 7
    const stiffness = omega * omega
    const damping = 2 * 0.28 * omega
    type GridDot = { cx: number, cy: number, xo: number, yo: number, vxo: number, vyo: number }
    let dots: GridDot[] = []
    let width = 0
    let height = 0
    let lastFrame = 0
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio ?? 1))
    const rebuild = (): void => {
      const rect = viewport.getBoundingClientRect()
      width = Math.max(1, Math.round(rect.width))
      height = Math.max(1, Math.round(rect.height))
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const cell = GRID.dotSize + GRID.gap
      const cols = Math.floor((width + GRID.gap) / cell)
      const rows = Math.floor((height + GRID.gap) / cell)
      const startX = (width - (cell * cols - GRID.gap)) / 2 + GRID.dotSize / 2
      const startY = (height - (cell * rows - GRID.gap)) / 2 + GRID.dotSize / 2
      dots = []
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          dots.push({ cx: startX + x * cell, cy: startY + y * cell, xo: 0, yo: 0, vxo: 0, vyo: 0 })
        }
      }
    }
    const pointer = { x: -1e4, y: -1e4, vx: 0, vy: 0, speed: 0, lastTime: 0, lastX: 0, lastY: 0 }
    let lastMoveAt = 0
    const onPointerMove = (event: PointerEvent): void => {
      const now = performance.now()
      const dt = pointer.lastTime !== 0 ? now - pointer.lastTime : 16
      const dx = event.clientX - pointer.lastX
      const dy = event.clientY - pointer.lastY
      let vx = (dx / Math.max(1, dt)) * 1000
      let vy = (dy / Math.max(1, dt)) * 1000
      const speed = Math.hypot(vx, vy)
      if (speed > 5000) {
        const scale = 5000 / speed
        vx *= scale
        vy *= scale
      }
      pointer.lastTime = now
      pointer.lastX = event.clientX
      pointer.lastY = event.clientY
      pointer.vx = vx
      pointer.vy = vy
      pointer.speed = speed
      const rect = viewport.getBoundingClientRect()
      pointer.x = event.clientX - rect.left
      pointer.y = event.clientY - rect.top
      // Throttled to 50ms like the original.
      if (now - lastMoveAt < 50) return
      lastMoveAt = now
      if (pointer.speed <= GRID.speedTrigger) return
      for (const dot of dots) {
        const dist = Math.hypot(dot.cx - pointer.x, dot.cy - pointer.y)
        if (dist < GRID.proximity) {
          dot.vxo += (dot.cx - pointer.x + pointer.vx * 0.005) * omega
          dot.vyo += (dot.cy - pointer.y + pointer.vy * 0.005) * omega
        }
      }
    }
    const onClick = (event: MouseEvent): void => {
      const rect = viewport.getBoundingClientRect()
      const cx = event.clientX - rect.left
      const cy = event.clientY - rect.top
      for (const dot of dots) {
        const dist = Math.hypot(dot.cx - cx, dot.cy - cy)
        if (dist < GRID.shockRadius) {
          const falloff = Math.max(0, 1 - dist / GRID.shockRadius)
          dot.vxo += (dot.cx - cx) * GRID.shockStrength * falloff * omega
          dot.vyo += (dot.cy - cy) * GRID.shockStrength * falloff * omega
        }
      }
    }
    const tick = (time: number): void => {
      const dt = Math.min(0.05, lastFrame !== 0 ? (time - lastFrame) / 1000 : 0.016)
      lastFrame = time
      ctx.clearRect(0, 0, width, height)
      ctx.fillStyle = GRID.color
      for (const dot of dots) {
        dot.vxo += (-stiffness * dot.xo - damping * dot.vxo) * dt
        dot.vyo += (-stiffness * dot.yo - damping * dot.vyo) * dt
        dot.xo += dot.vxo * dt
        dot.yo += dot.vyo * dt
        ctx.beginPath()
        ctx.arc(dot.cx + dot.xo, dot.cy + dot.yo, GRID.dotSize / 2, 0, Math.PI * 2)
        ctx.fill()
      }
      frame = window.requestAnimationFrame(tick)
    }
    let frame = 0
    rebuild()
    if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true) {
      // Static lattice: the grid only ever moves from pointer input anyway.
      ctx.fillStyle = GRID.color
      for (const dot of dots) {
        ctx.beginPath()
        ctx.arc(dot.cx, dot.cy, GRID.dotSize / 2, 0, Math.PI * 2)
        ctx.fill()
      }
    } else {
      frame = window.requestAnimationFrame(tick)
      viewport.addEventListener('pointermove', onPointerMove, true)
      viewport.addEventListener('click', onClick, true)
    }
    const observer = new ResizeObserver(rebuild)
    observer.observe(viewport)
    return () => {
      window.cancelAnimationFrame(frame)
      observer.disconnect()
      viewport.removeEventListener('pointermove', onPointerMove)
      viewport.removeEventListener('click', onClick)
    }
  }, [])
  return <canvas ref={canvasRef} className={css.sceneCanvas} aria-hidden="true" />
}

/** reactbits.dev "ShapeGrid": a continuously scrolling square grid; the cell
 *  under the pointer fills dark while it passes (canvas 2D). */
export function ShapeGridBackground(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    const layer = canvas?.parentElement
    const viewport = layer?.parentElement
    if (canvas === null || canvas === undefined || viewport === null || viewport === undefined) return
    const ctx = canvas.getContext('2d')
    if (ctx === null) return
    const SHAPE = { size: 40, speed: 1, border: '#999999', hoverFill: '#222222' }
    let width = 0
    let height = 0
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio ?? 1))
    const offset = { x: 0, y: 0 }
    const opacities = new Map<string, number>()
    let hovered: { x: number, y: number } | null = null
    const rebuild = (): void => {
      const rect = viewport.getBoundingClientRect()
      width = Math.max(1, Math.round(rect.width))
      height = Math.max(1, Math.round(rect.height))
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    const wrap = (value: number, modulo: number): number => ((value % modulo) + modulo) % modulo
    const cellOffsetX = (): number => wrap(offset.x, SHAPE.size)
    const cellOffsetY = (): number => wrap(offset.y, SHAPE.size)
    const draw = (): void => {
      ctx.clearRect(0, 0, width, height)
      const offsetX = cellOffsetX()
      const offsetY = cellOffsetY()
      const cols = Math.ceil(width / SHAPE.size) + 3
      const rows = Math.ceil(height / SHAPE.size) + 3
      ctx.strokeStyle = SHAPE.border
      ctx.lineWidth = 1
      for (let col = -2; col < cols; col++) {
        for (let row = -2; row < rows; row++) {
          const sx = col * SHAPE.size + offsetX
          const sy = row * SHAPE.size + offsetY
          const key = `${col},${row}`
          const alpha = opacities.get(key)
          if (alpha !== undefined) {
            ctx.globalAlpha = alpha
            ctx.fillStyle = SHAPE.hoverFill
            ctx.fillRect(sx, sy, SHAPE.size, SHAPE.size)
            ctx.globalAlpha = 1
          }
          ctx.strokeRect(sx, sy, SHAPE.size, SHAPE.size)
        }
      }
    }
    const updateOpacities = (): void => {
      for (const [key, opacity] of opacities) {
        const goal = hovered !== null && key === `${hovered.x},${hovered.y}` ? 1 : 0
        const next = opacity + (goal - opacity) * 0.15
        if (next < 0.005) opacities.delete(key)
        else opacities.set(key, next)
      }
      if (hovered !== null && !opacities.has(`${hovered.x},${hovered.y}`)) opacities.set(`${hovered.x},${hovered.y}`, 0)
    }
    const tick = (): void => {
      // direction 'right': the original steps the offset by -speed per frame.
      offset.x = wrap(offset.x - SHAPE.speed, SHAPE.size)
      updateOpacities()
      draw()
      frame = window.requestAnimationFrame(tick)
    }
    const onPointerMove = (event: PointerEvent): void => {
      const rect = viewport.getBoundingClientRect()
      const col = Math.floor((event.clientX - rect.left - cellOffsetX()) / SHAPE.size)
      const row = Math.floor((event.clientY - rect.top - cellOffsetY()) / SHAPE.size)
      if (hovered === null || hovered.x !== col || hovered.y !== row) hovered = { x: col, y: row }
    }
    const onPointerLeave = (): void => { hovered = null }

    rebuild()
    let frame = 0
    if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true) {
      draw()
    } else {
      frame = window.requestAnimationFrame(tick)
      viewport.addEventListener('pointermove', onPointerMove, true)
      viewport.addEventListener('pointerleave', onPointerLeave)
    }
    const observer = new ResizeObserver(rebuild)
    observer.observe(viewport)
    return () => {
      window.cancelAnimationFrame(frame)
      observer.disconnect()
      viewport.removeEventListener('pointermove', onPointerMove)
      viewport.removeEventListener('pointerleave', onPointerLeave)
    }
  }, [])
  return <canvas ref={canvasRef} className={css.sceneCanvas} aria-hidden="true" />
}

