type ExecutionResultBase = {
  sbxId: string
}

export type ExecutionResultWeb = ExecutionResultBase & {
  template: string
  url: string
}

export type ExecutionResult = ExecutionResultWeb
