type ExecutionResultBase = {
  sbxId: string
}

export type ExecutionResultWeb = ExecutionResultBase & {
  template: string
  url: string
}

export type ExecutionResult = ExecutionResultWeb

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object
    ? DeepPartial<T[K]>
    : T[K]
}
