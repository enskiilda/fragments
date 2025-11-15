import { handleAPIError, createRateLimitResponse } from '@/lib/api-errors'
import { Duration } from '@/lib/duration'
import { streamNvidiaChatCompletion } from '@/lib/openai'
import ratelimit from '@/lib/ratelimit'
import { fragmentSchema } from '@/lib/schema'
import { Templates, templatesToPrompt } from '@/lib/templates'
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

type ChatRequestBody = {
  messages: IncomingMessage[]
  userID?: string
  teamID?: string
  template: Templates
  config: LLMModelConfig
}

function createSystemPrompt(template: Templates) {
  return [
    'Jesteś doświadczonym inżynierem oprogramowania i ekspertem Next.js.',
    'Udzielasz odpowiedzi wyłącznie po polsku.',
    'Najpierw wypisujesz komentarz w znacznikach <COMMENTARY>...</COMMENTARY>, a następnie kompletny obiekt JSON w znacznikach <JSON>...</JSON>.',
    'JSON musi być zgodny ze schematem fragmentu i zawierać kompletne pliki oraz komentarz.',
    'W komentarzu opisujesz szczegółowy plan działań.',
    'W polu entry_file_path podajesz ścieżkę do pliku oznaczonego jako is_entry=true.',
    'Dokładnie jeden plik ma is_entry ustawione na true.',
    'Tworzysz kompletne wieloplikowe aplikacje Next.js, możesz dodawać foldery i pliki według potrzeb.',
    'Nie dodajesz żadnego innego tekstu poza wymaganymi znacznikami.',
    'Szablony dostępne w tym zadaniu:',
    templatesToPrompt(template),
  ].join('\n')
}

function enqueueEvent(controller: ReadableStreamDefaultController<Uint8Array>, data: unknown) {
  const encoder = new TextEncoder()
  controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
}

export async function POST(req: Request) {
  const { messages, template, config }: ChatRequestBody = await req.json()
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

  const systemPrompt = createSystemPrompt(template)
  const openAIMessages = [
    { role: 'system' as const, content: systemPrompt },
    ...normalizedMessages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
  ]

  try {
    const completion = streamNvidiaChatCompletion({
      model: 'moonshotai/kimi-k2-instruct-0905',
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

        try {
          for await (const chunk of completion) {
            const delta = chunk.choices?.[0]?.delta
            if (!delta?.content) {
              continue
            }

            pending += delta.content

            processPending()
          }

          finalize()
        } catch (error) {
          enqueueEvent(controller, {
            type: 'error',
            value: 'Wystąpił problem podczas generowania odpowiedzi.',
          })
          console.error('Chat stream error', error)
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
                const fragment = fragmentSchema.parse(
                  JSON.parse(jsonBuffer.trim()),
                )
                enqueueEvent(controller, {
                  type: 'fragment',
                  value: fragment,
                })
              } catch (error) {
                console.error('Failed to parse fragment JSON', error, jsonBuffer)
                enqueueEvent(controller, {
                  type: 'error',
                  value:
                    'Nie udało się sparsować wygenerowanego fragmentu. Spróbuj ponownie.',
                })
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
