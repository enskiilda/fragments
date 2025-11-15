export function getTemplateIdSuffix(id: string) {
  const isDev = process.env.NODE_ENV === 'development'
  return isDev ? `${id}-dev` : id
}

export function getTemplateId(id: string) {
  return id.replace(/-dev$/, '')
}

type TemplateDefinition = {
  name: string
  lib: string[]
  entry: string
  instructions: string
  port: number | null
}

const templates: Record<string, TemplateDefinition> = {
  [getTemplateIdSuffix('nextjs-developer')]: {
    name: 'Next.js developer',
    lib: [
      'nextjs@14.2.5',
      'typescript',
      '@types/node',
      '@types/react',
      '@types/react-dom',
      'postcss',
      'tailwindcss',
      'shadcn',
    ],
    entry: 'pages/index.tsx',
    instructions:
      'Pełna aplikacja Next.js 13+ korzystająca z routera Pages. Zawsze generuj kompletny projekt gotowy do uruchomienia, twórz dowolną liczbę plików i folderów (np. komponenty, style, utils).',
    port: 3000,
  },
}

export type Templates = typeof templates
export default templates

export function templatesToPrompt(templates: Templates) {
  return `${Object.entries(templates)
    .map(
      ([id, t], index) =>
        `${index + 1}. ${id}: "${t.instructions}". entry_file_path ustaw na ${t.entry}. Zainstalowane zależności: ${t.lib.join(', ')}. Port: ${t.port || 'brak'}.`,
    )
    .join('\n')}`
}
