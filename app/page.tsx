'use client'

import { ViewType } from '@/components/auth'
import { AuthDialog } from '@/components/auth-dialog'
import { Chat } from '@/components/chat'
import { ChatInput } from '@/components/chat-input'
import { ChatPicker } from '@/components/chat-picker'
import { ChatSettings } from '@/components/chat-settings'
import { NavBar } from '@/components/navbar'
import { Preview } from '@/components/preview'
import { useAuth } from '@/lib/auth'
import { Message, toMessageImage, toRequestMessages } from '@/lib/messages'
import { LLMModelConfig } from '@/lib/models'
import modelsList from '@/lib/models.json'
import { FragmentSchema } from '@/lib/schema'
import { supabase } from '@/lib/supabase'
import templates, { Templates } from '@/lib/templates'
import { DeepPartial, ExecutionResult } from '@/lib/types'
import { usePostHog } from 'posthog-js/react'
import {
  SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useLocalStorage } from 'usehooks-ts'

type RequestMessage = {
  role: 'user' | 'assistant'
  content: string
}

type SubmitPayload = {
  userID?: string
  teamID?: string
  messages: RequestMessage[]
  template: Templates
  config: LLMModelConfig
  currentFragment?: FragmentSchema
}

type StreamEvent =
  | { type: 'commentary'; value: string }
  | { type: 'fragment'; value: FragmentSchema }
  | { type: 'error'; value: string }

export default function Home() {
  const [chatInput, setChatInput] = useLocalStorage('chat', '')
  const [files, setFiles] = useState<File[]>([])
  const templateIds = Object.keys(templates)
  const [selectedTemplate, setSelectedTemplate] = useState<string>(
    templateIds[0] ?? '',
  )
  const [languageModel, setLanguageModel] = useLocalStorage<LLMModelConfig>(
    'languageModel',
    {
      model: 'moonshotai/kimi-k2-instruct-0905',
      temperature: 0,
      topP: 0.9,
      maxTokens: 4096,
    },
  )

  const posthog = usePostHog()

  const [result, setResult] = useState<ExecutionResult>()
  const [messages, setMessages] = useState<Message[]>([])
  const [fragment, setFragment] = useState<FragmentSchema>()
  const [pendingFragment, setPendingFragment] =
    useState<DeepPartial<FragmentSchema>>()
  const [currentTab, setCurrentTab] = useState<'code' | 'fragment'>('code')
  const [isPreviewLoading, setIsPreviewLoading] = useState(false)
  const [isAuthDialogOpen, setAuthDialog] = useState(false)
  const [authView, setAuthView] = useState<ViewType>('sign_in')
  const [isRateLimited, setIsRateLimited] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [error, setError] = useState<Error>()
  const [isLoading, setIsLoading] = useState(false)
  const { session, userTeam } = useAuth(setAuthDialog, setAuthView)
  const [useMorphApply, setUseMorphApply] = useLocalStorage(
    'useMorphApply',
    process.env.NEXT_PUBLIC_USE_MORPH_APPLY === 'true',
  )

  const abortController = useRef<AbortController | null>(null)
  const lastRequest = useRef<{ endpoint: string; payload: SubmitPayload }>()

  const filteredModels = useMemo(() => {
    return modelsList.models.filter((model) => {
      if (process.env.NEXT_PUBLIC_HIDE_LOCAL_MODELS) {
        return model.providerId !== 'ollama'
      }
      return true
    })
  }, [])

  const currentModel = filteredModels.find(
    (model) => model.id === languageModel.model,
  )
  const currentTemplate: Templates =
    selectedTemplate && templates[selectedTemplate]
      ? ({ [selectedTemplate]: templates[selectedTemplate] } as Templates)
      : templates
  const lastMessage = messages[messages.length - 1]

  const shouldUseMorph =
    useMorphApply &&
    fragment &&
    Array.isArray(fragment.files) &&
    fragment.files.length > 0 &&
    fragment.entry_file_path
  const apiEndpoint = shouldUseMorph ? '/api/morph-chat' : '/api/chat'

  useEffect(() => {
    if (!pendingFragment) {
      return
    }

    const content: Message['content'] = []

    if (pendingFragment.commentary) {
      content.push({ type: 'text', text: pendingFragment.commentary })
    }

    if (
      pendingFragment.files &&
      pendingFragment.files.length > 0 &&
      pendingFragment.files.every((file) => file?.file_path)
    ) {
      const formattedCode = pendingFragment.files
        .map((file) => {
          if (!file?.file_path) {
            return ''
          }

          const fileContent = file.file_content ?? ''
          return `// ${file.file_path}\n${fileContent}`
        })
        .join('\n\n')

      content.push({ type: 'code', text: formattedCode })
    }

    if (content.length === 0) {
      return
    }

    if (!lastMessage || lastMessage.role !== 'assistant') {
      addMessage({
        role: 'assistant',
        content,
        object: pendingFragment,
      })
    } else {
      setMessage({
        content,
        object: pendingFragment,
      })
    }
  }, [pendingFragment, lastMessage])

  const stop = useCallback(() => {
    if (abortController.current) {
      abortController.current.abort()
      abortController.current = null
    }
  }, [])

  async function handleSubmitAuth(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()

    if (!session) {
      return setAuthDialog(true)
    }

    if (isLoading) {
      stop()
    }

    const content: Message['content'] = [{ type: 'text', text: chatInput }]
    const images = await toMessageImage(files)

    if (images.length > 0) {
      images.forEach((image) => {
        content.push({ type: 'image', image })
      })
    }

    const updatedMessages = addMessage({
      role: 'user',
      content,
    })

    const payload: SubmitPayload = {
      userID: session?.user?.id,
      teamID: userTeam?.id,
      messages: toRequestMessages(updatedMessages),
      template: currentTemplate,
      config: languageModel,
      ...(shouldUseMorph && fragment ? { currentFragment: fragment } : {}),
    }

    await generateFragment(apiEndpoint, payload)

    setChatInput('')
    setFiles([])
    setCurrentTab('code')

    posthog.capture('chat_submit', {
      template: selectedTemplate,
      model: languageModel.model,
    })
  }

  async function generateFragment(endpoint: string, payload: SubmitPayload) {
    setIsLoading(true)
    setError(undefined)
    setErrorMessage('')
    setIsRateLimited(false)
    setPendingFragment(undefined)
    lastRequest.current = { endpoint, payload }

    const controller = new AbortController()
    abortController.current = controller

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        body: JSON.stringify(payload),
        signal: controller.signal,
      })

      if (response.status === 429) {
        const message = await response.text()
        setIsRateLimited(true)
        setErrorMessage(
          message || 'You have reached your request limit for the day.',
        )
        setError(new Error(message || 'Rate limited'))
        return
      }

      if (!response.ok || !response.body) {
        const message = await response.text()
        throw new Error(message || 'Nie udało się wygenerować odpowiedzi.')
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let commentary = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          break
        }

        buffer += decoder.decode(value, { stream: true })
        const events = buffer.split('\n\n')
        buffer = events.pop() ?? ''

        for (const event of events) {
          if (!event.startsWith('data:')) {
            continue
          }

          const parsed: StreamEvent = JSON.parse(event.slice(5).trim())

          if (parsed.type === 'commentary') {
            commentary += parsed.value
            setPendingFragment((previous) => ({
              ...previous,
              commentary,
            }))
          } else if (parsed.type === 'fragment') {
            setPendingFragment(parsed.value)
            await handleFragmentComplete(parsed.value)
          } else if (parsed.type === 'error') {
            throw new Error(parsed.value)
          }
        }
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        return
      }

      console.error('Error submitting request:', err)
      const message = err instanceof Error ? err.message : 'Wystąpił błąd.'
      setError(err instanceof Error ? err : new Error(message))
      setErrorMessage(message)
    } finally {
      setIsLoading(false)
      abortController.current = null
    }
  }

  async function handleFragmentComplete(fragment: FragmentSchema) {
    try {
      setIsPreviewLoading(true)
      posthog.capture('fragment_generated', {
        template: fragment.template,
      })

      const response = await fetch('/api/sandbox', {
        method: 'POST',
        body: JSON.stringify({
          fragment,
          userID: session?.user?.id,
          teamID: userTeam?.id,
          accessToken: session?.access_token,
        }),
      })

      if (!response.ok) {
        const message = await response.text()
        throw new Error(message || 'Nie udało się utworzyć sandboxa.')
      }

      const executionResult: ExecutionResult = await response.json()
      posthog.capture('sandbox_created', { url: executionResult.url })

      setResult(executionResult)
      setCurrentPreview({ fragment, result: executionResult })
      setMessage({ result: executionResult })
      setCurrentTab('fragment')
    } catch (err: any) {
      console.error('Sandbox error:', err)
      const message = err instanceof Error ? err.message : 'Wystąpił błąd.'
      setError(err instanceof Error ? err : new Error(message))
      setErrorMessage(message)
    } finally {
      setIsPreviewLoading(false)
    }
  }

  function retry() {
    if (!lastRequest.current) {
      return
    }

    generateFragment(lastRequest.current.endpoint, lastRequest.current.payload)
  }

  function addMessage(message: Message) {
    let updatedMessages: Message[] = []
    setMessages((previousMessages) => {
      updatedMessages = [...previousMessages, message]
      return updatedMessages
    })
    return updatedMessages
  }

  function setMessage(message: Partial<Message>, index?: number) {
    setMessages((previousMessages) => {
      if (previousMessages.length === 0) {
        return previousMessages
      }

      const targetIndex = index ?? previousMessages.length - 1
      const updatedMessages = [...previousMessages]
      updatedMessages[targetIndex] = {
        ...previousMessages[targetIndex],
        ...message,
      }

      return updatedMessages
    })
  }

  function handleSaveInputChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setChatInput(e.target.value)
  }

  function handleFileChange(change: SetStateAction<File[]>) {
    setFiles(change)
  }

  function logout() {
    supabase
      ? supabase.auth.signOut()
      : console.warn('Supabase is not initialized')
  }

  function handleLanguageModelChange(e: LLMModelConfig) {
    setLanguageModel({ ...languageModel, ...e })
  }

  function handleSocialClick(target: 'github' | 'x' | 'discord') {
    if (target === 'github') {
      window.open('https://github.com/e2b-dev/fragments', '_blank')
    } else if (target === 'x') {
      window.open('https://x.com/e2b', '_blank')
    } else if (target === 'discord') {
      window.open('https://discord.gg/e2b', '_blank')
    }

    posthog.capture(`${target}_click`)
  }

  function handleClearChat() {
    stop()
    setChatInput('')
    setFiles([])
    setMessages([])
    setFragment(undefined)
    setPendingFragment(undefined)
    setResult(undefined)
    setCurrentTab('code')
    setIsPreviewLoading(false)
    setError(undefined)
    setErrorMessage('')
    setIsRateLimited(false)
    lastRequest.current = undefined
  }

  function setCurrentPreview(preview: {
    fragment: FragmentSchema | undefined
    result: ExecutionResult | undefined
  }) {
    setFragment(preview.fragment)
    setResult(preview.result)
  }

  function handleUndo() {
    setMessages((previousMessages) => [...previousMessages.slice(0, -2)])
    setCurrentPreview({ fragment: undefined, result: undefined })
    setPendingFragment(undefined)
  }

  return (
    <main className="flex min-h-screen max-h-screen">
      {supabase && (
        <AuthDialog
          open={isAuthDialogOpen}
          setOpen={setAuthDialog}
          view={authView}
          supabase={supabase}
        />
      )}
      <div className="grid w-full md:grid-cols-2">
        <div
          className={`flex flex-col w-full max-h-full max-w-[800px] mx-auto px-4 overflow-auto ${fragment ? 'col-span-1' : 'col-span-2'}`}
        >
          <NavBar
            session={session}
            showLogin={() => setAuthDialog(true)}
            signOut={logout}
            onSocialClick={handleSocialClick}
            onClear={handleClearChat}
            canClear={messages.length > 0}
            canUndo={messages.length > 1 && !isLoading}
            onUndo={handleUndo}
          />
          <Chat
            messages={messages}
            isLoading={isLoading}
            setCurrentPreview={setCurrentPreview}
          />
          <ChatInput
            retry={retry}
            isErrored={Boolean(error) || isRateLimited}
            errorMessage={errorMessage}
            isLoading={isLoading}
            isRateLimited={isRateLimited}
            stop={stop}
            input={chatInput}
            handleInputChange={handleSaveInputChange}
            handleSubmit={handleSubmitAuth}
            isMultiModal={currentModel?.multiModal || false}
            files={files}
            handleFileChange={handleFileChange}
          >
            <ChatPicker
              templates={templates}
              selectedTemplate={selectedTemplate}
              onSelectedTemplateChange={setSelectedTemplate}
              models={filteredModels}
              languageModel={languageModel}
              onLanguageModelChange={handleLanguageModelChange}
            />
            <ChatSettings
              languageModel={languageModel}
              onLanguageModelChange={handleLanguageModelChange}
              useMorphApply={useMorphApply}
              onUseMorphApplyChange={setUseMorphApply}
            />
          </ChatInput>
        </div>
        <Preview
          teamID={userTeam?.id}
          accessToken={session?.access_token}
          selectedTab={currentTab}
          onSelectedTabChange={setCurrentTab}
          isChatLoading={isLoading}
          isPreviewLoading={isPreviewLoading}
          fragment={fragment}
          result={result as ExecutionResult}
          onClose={() => setFragment(undefined)}
        />
      </div>
    </main>
  )
}
