import note from './notes/note.md?raw'
import meeting from './notes/meeting.md?raw'
import daily from './notes/daily.md?raw'
import technical from './reports/technical.md?raw'
import proposal from './reports/proposal.md?raw'
import minutes from './reports/minutes.md?raw'
import academic from './reports/academic.md?raw'
import type { Template } from '../../preload/index'

/** Built-in templates; user ones come from userData/templates/{notes,reports}. */
export const BUILTIN_TEMPLATES: Template[] = [
  { id: 'builtin:notes/note', kind: 'notes', name: 'Note', content: note },
  { id: 'builtin:notes/meeting', kind: 'notes', name: 'Meeting notes', content: meeting },
  { id: 'builtin:notes/daily', kind: 'notes', name: 'Daily note', content: daily },
  { id: 'builtin:reports/technical', kind: 'reports', name: 'Technical report', content: technical },
  { id: 'builtin:reports/proposal', kind: 'reports', name: 'Project proposal', content: proposal },
  { id: 'builtin:reports/minutes', kind: 'reports', name: 'Meeting minutes', content: minutes },
  { id: 'builtin:reports/academic', kind: 'reports', name: 'Academic paper', content: academic }
]
