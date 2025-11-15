import { z } from 'zod'

export const fragmentFileSchema = z.object({
  file_path: z
    .string()
    .describe('Relatywna ścieżka do pliku wraz z nazwą (może zawierać podkatalogi).'),
  file_content: z
    .string()
    .describe('Pełna zawartość pliku. Zawsze generuj kompletną treść, a nie fragmenty.'),
  is_entry: z
    .boolean()
    .describe('Ustaw na true tylko dla głównego pliku startowego aplikacji.'),
})

export const fragmentSchema = z
  .object({
    commentary: z
      .string()
      .describe(
        'Szczegółowo opisz plan działania i wszystkie kroki, które podejmiesz podczas generowania aplikacji.',
      ),
    template: z
      .string()
      .describe('Nazwa użytego szablonu.'),
    title: z.string().describe('Krótki tytuł aplikacji. Maksymalnie 3 słowa.'),
    description: z
      .string()
      .describe('Zwięzły opis aplikacji. Maksymalnie jedno zdanie.'),
    additional_dependencies: z
      .array(z.string())
      .describe(
        'Lista dodatkowych zależności wymaganych przez aplikację. Nie powtarzaj zależności dostarczonych przez szablon.',
      ),
    has_additional_dependencies: z
      .boolean()
      .describe('Czy aplikacja wymaga dodatkowych zależności spoza szablonu.'),
    install_dependencies_command: z
      .string()
      .describe('Komenda do instalacji dodatkowych zależności.'),
    port: z
      .number()
      .nullable()
      .describe('Port wykorzystywany przez aplikację. Jeśli brak portu, ustaw null.'),
    entry_file_path: z
      .string()
      .describe('Relatywna ścieżka do głównego pliku startowego aplikacji.'),
    files: z
      .array(fragmentFileSchema)
      .describe('Pełna lista plików tworzących aplikację. Możesz tworzyć wiele folderów.'),
  })
  .superRefine((fragment, ctx) => {
    const entryFiles = fragment.files.filter((file) => file.is_entry)

    if (entryFiles.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['files'],
        message: 'Dokładnie jeden plik musi mieć is_entry ustawione na true.',
      })
    }

    if (entryFiles[0] && entryFiles[0].file_path !== fragment.entry_file_path) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['entry_file_path'],
        message: 'entry_file_path musi odpowiadać plikowi oznaczonemu jako is_entry.',
      })
    }
  })

export type FragmentSchema = z.infer<typeof fragmentSchema>

// Schema for morph edit instructions
export const morphEditSchema = z.object({
  commentary: z
    .string()
    .describe('Wyjaśnij, jakie zmiany wprowadzasz i dlaczego.'),
  instruction: z
    .string()
    .describe('Jednozdaniowy opis zmiany.'),
  edit: z
    .string()
    .describe(
      "Zachowaj jasność zmian i minimalizuj niezmieniony kod, używaj komentarza // ... existing code ... do pominiętych fragmentów.",
    ),
  file_path: z.string().describe('Ścieżka pliku, którego dotyczy edycja.'),
})

export type MorphEditSchema = z.infer<typeof morphEditSchema>
