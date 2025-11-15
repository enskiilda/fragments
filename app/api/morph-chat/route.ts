import { handleAPIError, createRateLimitResponse } from '@/lib/api-errors'
import { Duration } from '@/lib/duration'
import { openai } from '@/lib/openai'
import { applyPatch } from '@/lib/morph'
import ratelimit from '@/lib/ratelimit'
import { FragmentSchema, morphEditSchema, MorphEditSchema } from '@/lib/schema'
import { LLMModelConfig } from '@/lib/models'

export const maxDuration = 300

const rateLimitMaxRequests = process.env.RATE_LIMIT_MAX_REQUESTS
  ? parseInt(process.env.RATE_LIMIT_MAX_REQUESTS)
  : 10
const ratelimitWindow = process.env.RATE_LIMIT_WINDOW
  ? (process.env.RATE_LIMIT_WINDOW as Duration)
  : '1d'

const COMMENTARY_OPEN = '<COMMENTARY>'
const COMMENTARY_CLOSE = '</COMMENTARY>'
const JSON_OPEN = '<JSON>'
const JSON_CLOSE = '</JSON>'

type IncomingMessage = {
  role: 'user' | 'assistant'
  content: string
}

type MorphRequestBody = {
  messages: IncomingMessage[]
  model?: unknown
  config: LLMModelConfig
  currentFragment: FragmentSchema
}

function enqueueEvent(controller: ReadableStreamDefaultController<Uint8Array>, data: unknown) {
  const encoder = new TextEncoder()
  controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
}

export async function POST(req: Request) {
  const { messages, config, currentFragment }: MorphRequestBody = await req.json()
  const resolvedConfig: LLMModelConfig = config || {}
  const normalizedMessages = Array.isArray(messages) ? messages : []

  const limit = resolvedConfig.apiKey
    ? false
    : await ratelimit(
        req.headers.get('x-forwarded-for'),
        rateLimitMaxRequests,
        ratelimitWindow,
      )

  if (limit) {
    return createRateLimitResponse(limit)
  }

  const targetFile =
    currentFragment.files.find((file) => file.is_entry) ??
    currentFragment.files[0]

  if (!targetFile) {
    return handleAPIError(
      new Error('Brak pliku do edycji w aktualnym fragmencie'),
      { hasOwnApiKey: false },
    )
  }

  const systemPrompt = [
    'Jesteś doświadczonym edytorem kodu.',
    'Twoja odpowiedź ma mieć dwie części: komentarz w znacznikach <COMMENTARY>...</COMMENTARY> oraz instrukcje edycji JSON w znacznikach <JSON>...</JSON>.',
    'JSON musi mieć pola commentary, instruction, edit oraz file_path i być zgodny ze schematem morphEditSchema.',
    'Komentarz opisuje zmiany, JSON zawiera instrukcje edycji dla wskazanego pliku.',
    `Aktualnie edytowany plik: ${targetFile.file_path}.`,
    'Wstawiaj jedynie wymagane znaczniki, bez dodatkowego tekstu.',
  ].join('\n')

  const openAIMessages = [
    { role: 'system' as const, content: systemPrompt },
    ...normalizedMessages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
  ]

  try {
    const completion = await openai.chat.completions.create({
      model: 'moonshotai/kimi-k2-instruct-0905',
      stream: true,
      temperature: resolvedConfig.temperature ?? 0,
      top_p: resolvedConfig.topP ?? 0.9,
      max_tokens: resolvedConfig.maxTokens ?? 4096,
      messages: openAIMessages,
    })

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let mode: 'commentary' | 'json' | null = null
        let pending = ''
        let jsonBuffer = ''
        let editInstructions: MorphEditSchema | null = null

        try {
          for await (const chunk of completion) {
            const delta = chunk.choices[0]?.delta
            if (!delta?.content) {
              continue
            }

            pending += delta.content
            processPending()
          }

          finalize()

          if (editInstructions) {
            const fileToEdit = currentFragment.files.find(
              (file) => file.file_path === editInstructions?.file_path,
            )

            if (!fileToEdit) {
              enqueueEvent(controller, {
                type: 'error',
                value:
                  'Nie udało się odnaleźć wskazanego pliku do edycji. Spróbuj ponownie.',
              })
            } else {
              const morphResult = await applyPatch({
                targetFile: editInstructions.file_path,
                instructions: editInstructions.instruction,
                initialCode: fileToEdit.file_content,
                codeEdit: editInstructions.edit,
              })

              const updatedFragment: FragmentSchema = {
                ...currentFragment,
                files: currentFragment.files.map((file) =>
                  file.file_path === editInstructions.file_path
                    ? { ...file, file_content: morphResult.code }
                    : file,
                ),
                commentary: editInstructions.commentary,
              }

              enqueueEvent(controller, {
                type: 'fragment',
                value: updatedFragment,
              })
            }
          }
        } catch (error) {
          enqueueEvent(controller, {
            type: 'error',
            value: 'Wystąpił problem podczas edycji pliku.',
          })
          console.error('Morph stream error', error)
        } finally {
          controller.close()
        }

        function processPending() {
          while (pending.length > 0) {
            if (!mode) {
              const nextCommentary = pending.indexOf(COMMENTARY_OPEN)
              const nextJson = pending.indexOf(JSON_OPEN)

              if (nextCommentary === -1 && nextJson === -1) {
                const minTagLength = Math.max(
                  COMMENTARY_OPEN.length,
                  JSON_OPEN.length,
                )
                if (pending.length > minTagLength) {
                  pending = pending.slice(pending.length - minTagLength)
                }
                return
              }

              const useCommentary =
                nextCommentary !== -1 &&
                (nextJson === -1 || nextCommentary < nextJson)

              if (useCommentary) {
                pending = pending.slice(nextCommentary + COMMENTARY_OPEN.length)
                mode = 'commentary'
                continue
              }

              if (nextJson !== -1) {
                pending = pending.slice(nextJson + JSON_OPEN.length)
                mode = 'json'
                continue
              }

              return
            }

            if (mode === 'commentary') {
              const closeIndex = pending.indexOf(COMMENTARY_CLOSE)
              if (closeIndex === -1) {
                const safeLength = pending.length - (COMMENTARY_CLOSE.length - 1)
                if (safeLength > 0) {
                  const chunk = pending.slice(0, safeLength)
                  enqueueEvent(controller, { type: 'commentary', value: chunk })
                  pending = pending.slice(safeLength)
                }
                return
              }

              const chunk = pending.slice(0, closeIndex)
              if (chunk.length > 0) {
                enqueueEvent(controller, { type: 'commentary', value: chunk })
              }
              pending = pending.slice(closeIndex + COMMENTARY_CLOSE.length)
              mode = null
              continue
            }

            if (mode === 'json') {
              const closeIndex = pending.indexOf(JSON_CLOSE)
              if (closeIndex === -1) {
                jsonBuffer += pending
                pending = ''
                return
              }

              jsonBuffer += pending.slice(0, closeIndex)
              pending = pending.slice(closeIndex + JSON_CLOSE.length)

             try {
               editInstructions = morphEditSchema.parse(
                 JSON.parse(jsonBuffer.trim()),
               )
             } catch (error) {
               console.error('Failed to parse morph JSON', error, jsonBuffer)
               enqueueEvent(controller, {
                 type: 'error',
                 value:
                   'Nie udało się sparsować instrukcji edycji. Spróbuj ponownie.',
               })
                editInstructions = null
             }

              jsonBuffer = ''
              mode = null
              continue
            }
          }
        }

        function finalize() {
          if (mode === 'commentary' && pending.length > 0) {
            enqueueEvent(controller, { type: 'commentary', value: pending })
            pending = ''
          }
        }
      },
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    })
  } catch (error: any) {
    return handleAPIError(error, { hasOwnApiKey: !!resolvedConfig.apiKey })
  }
}
