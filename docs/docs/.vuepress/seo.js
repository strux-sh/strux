import { fs, path } from 'vuepress/utils'

// Search engines show about 155 characters of a description.
const DESCRIPTION_LIMIT = 158

// Plain text from one line of markdown: link labels, code without backticks, no emphasis markers or inline HTML.
const toPlainText = (text) =>
  text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/``([^`]+)``/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\W)\*([^*]+)\*(?=\W|$)/g, '$1$2')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()

// The prose that opens a page, after its H1: every page starts with sentences saying what it covers (docs/STYLE.md).
// Code fences, containers, components, tables, and lists are skipped; a very short opening borrows the next paragraph.
const openingText = (markdown) => {
  const lines = markdown.replace(/^---[\s\S]*?\n---\n/, '').split('\n')
  const paragraphs = []
  let paragraph = []
  let afterTitle = false
  let inFence = false
  let inTag = false
  let containerDepth = 0

  const flush = () => {
    if (paragraph.length) paragraphs.push(toPlainText(paragraph.join(' ')))
    paragraph = []
  }

  for (const line of lines) {
    const text = line.trim()

    if (text.startsWith('```')) {
      inFence = !inFence
      flush()
      continue
    }

    if (inFence) continue

    if (inTag) {
      if (/\/?>\s*$/.test(text)) inTag = false
      continue
    }

    if (!afterTitle) {
      if (text.startsWith('# ')) afterTitle = true
      continue
    }

    if (text.startsWith(':::')) {
      flush()
      containerDepth += text === ':::' ? -1 : 1
      continue
    }

    if (containerDepth > 0) continue

    if (text.startsWith('<')) {
      flush()
      if (!/>\s*$/.test(text)) inTag = true
      continue
    }

    if (!text) {
      flush()
      if (paragraphs.join(' ').length >= 110) break
      continue
    }

    if (/^(#|\||-|\*|\d+\.|>|!\[)/.test(text)) {
      flush()
      if (paragraphs.length) break
      continue
    }

    paragraph.push(text)
  }

  flush()

  return paragraphs.join(' ')
}

// Whole sentences up to the limit; a single long sentence is cut at a word boundary.
const clipDescription = (text) => {
  if (text.length <= DESCRIPTION_LIMIT) return text

  const sentences = text.match(/.*?[.!?](?=\s|$)/g) ?? []
  let clipped = ''

  for (const sentence of sentences) {
    if ((clipped + sentence).length > DESCRIPTION_LIMIT) break
    clipped += sentence
  }

  if (clipped.trim().length >= 70) return clipped.trim()

  return `${text.slice(0, DESCRIPTION_LIMIT - 1).replace(/\s+\S*$/, '')}…`
}

// VuePress writes head attributes without escaping, so straight double quotes become typographic ones.
const curlyQuotes = (text) => text.replace(/"([^"]*)"/g, '\u201C$1\u201D').replace(/"/g, '\u201D')

// A unique description for every page that does not set one in its frontmatter.
export const describePage = (page, fallback) => {
  if (page.frontmatter.description) return

  const description = page.frontmatter.home ? '' : clipDescription(openingText(page.content))

  page.frontmatter.description = curlyQuotes(description || fallback)
}

const sectionTitles = {
  guide: 'Guide',
  concepts: 'Concepts',
  api: 'Strux API',
  bsp: 'Board support packages',
  reference: 'Reference',
}

// Writes llms.txt, the plain-text map of the docs that AI assistants and answer engines read: every page with its URL and description.
export const llmsTxtPlugin = ({ hostname, title, description }) => ({
  name: 'strux-llms-txt',

  onGenerated: async (app) => {
    const sections = new Map()

    for (const page of app.pages) {
      if (!page.filePathRelative || page.frontmatter.home) continue

      const section = page.path.split('/')[1]
      const entries = sections.get(section) ?? []

      entries.push(`- [${page.title}](${hostname}${app.siteData.base.replace(/\/$/, '')}${page.path}): ${page.frontmatter.description}`)
      sections.set(section, entries)
    }

    const blocks = Object.entries(sectionTitles)
      .filter(([section]) => sections.has(section))
      .map(([section, heading]) => `## ${heading}\n\n${sections.get(section).join('\n')}`)

    const content = `# ${title}\n\n> ${description}\n\n${blocks.join('\n\n')}\n`

    await fs.writeFile(path.join(app.dir.dest(), 'llms.txt'), content)
  },
})
