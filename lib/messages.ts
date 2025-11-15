import { DeepPartial } from './types'
import { FragmentSchema } from './schema'
import { ExecutionResult } from './types'

export type MessageText = {
  type: 'text'
  text: string
}

export type MessageCode = {
  type: 'code'
  text: string
}

export type MessageImage = {
  type: 'image'
  image: string
}

export type Message = {
  role: 'assistant' | 'user'
  content: Array<MessageText | MessageCode | MessageImage>
  object?: DeepPartial<FragmentSchema>
  result?: ExecutionResult
}

export function toRequestMessages(messages: Message[]) {
  return messages.map((message) => ({
    role: message.role,
    content: message.content
      .map((content) => {
        if (content.type === 'text' || content.type === 'code') {
          return content.text
        }

        if (content.type === 'image') {
          return `![image](${content.image})`
        }

        return ''
      })
      .filter(Boolean)
      .join('\n\n'),
  }))
}

export async function toMessageImage(files: File[]) {
  if (files.length === 0) {
    return []
  }

  return Promise.all(
    files.map(async (file) => {
      const base64 = Buffer.from(await file.arrayBuffer()).toString('base64')
      return `data:${file.type};base64,${base64}`
    }),
  )
}
