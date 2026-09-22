/**
 * Template placeholders: {{title}}, {{date}}, {{date:FORMAT}}, {{time}},
 * {{author}}, {{filename}}, {{cursor}}. No logic, no nesting.
 */

export interface PlaceholderContext {
  title: string
  author: string
  filename: string
  now?: Date
}

export const CURSOR = '{{cursor}}'

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const pad = (n: number, w = 2): string => String(n).padStart(w, '0')

/** Moment-style tokens: YYYY YY MMMM MMM MM M DD D dddd ddd HH mm ss. */
export function formatDate(d: Date, fmt: string): string {
  return fmt.replace(/YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|mm|ss/g, (t) => {
    switch (t) {
      case 'YYYY': return String(d.getFullYear())
      case 'YY': return pad(d.getFullYear() % 100)
      case 'MMMM': return MONTHS[d.getMonth()]
      case 'MMM': return MONTHS[d.getMonth()].slice(0, 3)
      case 'MM': return pad(d.getMonth() + 1)
      case 'M': return String(d.getMonth() + 1)
      case 'DD': return pad(d.getDate())
      case 'D': return String(d.getDate())
      case 'dddd': return DAYS[d.getDay()]
      case 'ddd': return DAYS[d.getDay()].slice(0, 3)
      case 'HH': return pad(d.getHours())
      case 'mm': return pad(d.getMinutes())
      case 'ss': return pad(d.getSeconds())
      default: return t
    }
  })
}

/** Expand every placeholder except {{cursor}}, which the caller positions. */
export function expandPlaceholders(template: string, ctx: PlaceholderContext): string {
  const now = ctx.now ?? new Date()
  return template.replace(/\{\{\s*([a-z]+)(?::([^}]+))?\s*\}\}/gi, (m, name: string, arg?: string) => {
    switch (name.toLowerCase()) {
      case 'title': return ctx.title
      case 'author': return ctx.author
      case 'filename': return ctx.filename
      case 'date': return formatDate(now, arg?.trim() || 'YYYY-MM-DD')
      case 'time': return formatDate(now, arg?.trim() || 'HH:mm')
      case 'cursor': return CURSOR
      default: return m
    }
  })
}

/** Remove the cursor marker and report where it was (or the end of the text). */
export function takeCursor(text: string): { text: string; cursor: number } {
  const at = text.indexOf(CURSOR)
  if (at < 0) return { text, cursor: text.length }
  return { text: text.slice(0, at) + text.slice(at + CURSOR.length), cursor: at }
}

/** A safe file name derived from a title: "Q3 Report: draft!" → "Q3 Report - draft". */
export function slugFileName(title: string): string {
  const s = title.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').replace(/^[\s.-]+|[\s.-]+$/g, '').trim()
  return s || 'untitled'
}
