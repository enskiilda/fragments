'use client'

import { FragmentWeb } from './fragment-web'
import { ExecutionResult, ExecutionResultWeb } from '@/lib/types'

export function FragmentPreview({ result }: { result: ExecutionResult }) {
  return <FragmentWeb result={result as ExecutionResultWeb} />
}
