/** The icon names Tendril's UI uses; every set must provide all of them. */
export type IconName =
  | 'menu' | 'panel-left' | 'folder-open' | 'folder' | 'file' | 'file-text' | 'save'
  | 'list' | 'list-ordered' | 'eraser' | 'code' | 'printer' | 'settings'
  | 'pencil' | 'columns' | 'book-open' | 'minus' | 'square' | 'x'
  | 'table' | 'image' | 'chevron-right' | 'chevrons-left' | 'chevrons-right' | 'arrow-up' | 'home' | 'refresh-cw' | 'eye'
  | 'search' | 'plus-circle' | 'trash' | 'chevron-down' | 'sparkles' | 'send' | 'graph'

export interface IconSet {
  /** Attributes for the <svg> wrapper: viewBox plus fill/stroke conventions of the set. */
  attrs: string
  paths: Record<IconName, string>
}
