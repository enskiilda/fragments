const NVIDIA_API_KEY = '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'
const E2B_API_KEY = 'e2b_03d9b1c21997b9ef8ef13cfbff8fe7efbe2fdf4c'

if (!process.env.NVIDIA_API_KEY) {
  process.env.NVIDIA_API_KEY = NVIDIA_API_KEY
}

if (!process.env.E2B_API_KEY) {
  process.env.E2B_API_KEY = E2B_API_KEY
}

const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1'
const NVIDIA_CHAT_COMPLETIONS_URL = `${NVIDIA_BASE_URL}/chat/completions`

export type NvidiaChatMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type NvidiaChatCompletionChunk = {
  choices?: Array<{
    delta?: {
      content?: string
      tool_calls?: Array<{
        id?: string
        type?: string
        function?: {
          name?: string
          arguments?: string
        }
      }>
    }
  }>
}

export type NvidiaChatCompletionRequest = {
  model: string
  messages: NvidiaChatMessage[]
  temperature?: number
  top_p?: number
  max_tokens?: number
}

const DEFAULT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_current_weather',
      description:
        "Returns the current weather at a location, if one is specified, and defaults to the user's location.",
      parameters: {
        type: 'object',
        properties: {
          location: {
            type: 'string',
            description:
              "The location to find the weather of, or if not provided, it's the default location.",
          },
          format: {
            type: 'string',
            enum: ['celsius', 'fahrenheit'],
            description:
              'Whether to use SI or USCS units (celsius or fahrenheit).',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'describe_harry_potter_character',
      description: 'Returns information and images of Harry Potter characters.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            enum: [
              'Harry James Potter',
              'Hermione Jean Granger',
              'Ron Weasley',
              'Fred Weasley',
              'George Weasley',
              'Bill Weasley',
              'Percy Weasley',
              'Charlie Weasley',
              'Ginny Weasley',
              'Molly Weasley',
              'Arthur Weasley',
              'Neville Longbottom',
              'Luna Lovegood',
              'Draco Malfoy',
              'Albus Percival Wulfric Brian Dumbledore',
              'Minerva McGonagall',
              'Remus Lupin',
              'Rubeus Hagrid',
              'Sirius Black',
              'Severus Snape',
              'Bellatrix Lestrange',
              'Lord Voldemort',
              'Cedric Diggory',
              'Nymphadora Tonks',
              'James Potter',
            ],
            description: 'Name of the Harry Potter character',
          },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'name_a_color',
      description: 'A tool that returns a bunch of color names for a given color_hex.',
      parameters: {
        type: 'object',
        properties: {
          color_hex: {
            type: 'string',
            description:
              'A hexadecimal color value which must be represented as a string.',
          },
        },
        required: ['color_hex'],
      },
    },
  },
] as const

export async function* streamNvidiaChatCompletion(
  request: NvidiaChatCompletionRequest,
): AsyncGenerator<NvidiaChatCompletionChunk, void, unknown> {
  const response = await fetch(NVIDIA_CHAT_COMPLETIONS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${NVIDIA_API_KEY}`,
    },
    body: JSON.stringify({
      ...request,
      stream: true,
      tools: DEFAULT_TOOLS,
      tool_choice: 'auto',
    }),
  })

  if (!response.ok || !response.body) {
    const message = await response.text()
    throw new Error(
      `Żądanie do NVIDIA API nie powiodło się: ${response.status} ${response.statusText} ${message}`,
    )
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { value, done } = await reader.read()
    if (done) {
      break
    }

    buffer += decoder.decode(value, { stream: true })
    const events = buffer.split('\n\n')
    buffer = events.pop() ?? ''

    for (const event of events) {
      const trimmed = event.trim()
      if (!trimmed.startsWith('data:')) {
        continue
      }

      const data = trimmed.slice(5).trim()
      if (data.length === 0) {
        continue
      }

      if (data === '[DONE]') {
        return
      }

      try {
        const parsed = JSON.parse(data) as NvidiaChatCompletionChunk
        yield parsed
      } catch (error) {
        console.error('Nie udało się sparsować fragmentu odpowiedzi NVIDIA', data, error)
      }
    }
  }
}
