/** Colour arithmetic for the chart faces; every input is `#rrggbb` (see model.ts normColor). */

const rgb = (c: string): number[] => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16))
const hex = (n: number): string => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0')

function mix(c: string, target: number, t: number): string {
  return '#' + rgb(c).map((v) => hex(v + (target - v) * t)).join('')
}

/** Towards white by `t` (0..1). */
export const lighten = (c: string, t: number): string => mix(c, 255, t)
/** Towards black by `t` (0..1). */
export const darken = (c: string, t: number): string => mix(c, 0, t)

/** Relative luminance (WCAG), 0 = black, 1 = white. */
export function luminance(c: string): number {
  const [r, g, b] = rgb(c).map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** Text colour that reads on `c`. */
export const onColor = (c: string): string => (luminance(c) > 0.4 ? '#1f2328' : '#ffffff')
