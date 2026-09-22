/**
 * Word's "Insert Table" grid: hover to size the table, click to insert, or
 * type larger numbers underneath.
 */

const COLS = 10
const ROWS = 8

export function tablePicker(onPick: (cols: number, rows: number) => void): HTMLElement {
  const box = document.createElement('div')
  box.className = 'tbl-picker'
  const caption = document.createElement('div')
  caption.className = 'tbl-caption'
  caption.textContent = 'Insert Table'
  const grid = document.createElement('div')
  grid.className = 'tbl-grid'
  const cells: HTMLElement[] = []
  for (let r = 1; r <= ROWS; r++)
    for (let c = 1; c <= COLS; c++) {
      const cell = document.createElement('span')
      cell.dataset.c = String(c)
      cell.dataset.r = String(r)
      cells.push(cell)
      grid.appendChild(cell)
    }
  const highlight = (c: number, r: number): void => {
    for (const cell of cells) cell.classList.toggle('on', Number(cell.dataset.c) <= c && Number(cell.dataset.r) <= r)
    caption.textContent = c && r ? `${c} × ${r} Table` : 'Insert Table'
  }
  grid.addEventListener('mousemove', (e) => {
    const t = (e.target as HTMLElement).closest('span')
    if (t) highlight(Number(t.dataset.c), Number(t.dataset.r))
  })
  grid.addEventListener('mouseleave', () => highlight(0, 0))
  grid.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest('span')
    if (t) onPick(Number(t.dataset.c), Number(t.dataset.r))
  })

  const form = document.createElement('div')
  form.className = 'tbl-form'
  const num = (label: string, value: number): HTMLInputElement => {
    const l = document.createElement('label')
    l.textContent = label
    const i = document.createElement('input')
    i.type = 'number'
    i.min = '1'
    i.max = label === 'Columns' ? '50' : '200'
    i.value = String(value)
    l.appendChild(i)
    form.appendChild(l)
    return i
  }
  const colsIn = num('Columns', 3)
  const rowsIn = num('Rows', 3)
  const go = document.createElement('button')
  go.type = 'button'
  go.className = 'primary'
  go.textContent = 'Insert'
  const submit = (): void => onPick(Number(colsIn.value) || 1, Number(rowsIn.value) || 1)
  go.addEventListener('click', submit)
  for (const i of [colsIn, rowsIn]) i.addEventListener('keydown', (e) => e.key === 'Enter' && submit())
  form.appendChild(go)

  box.append(caption, grid, form)
  return box
}
