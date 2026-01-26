export enum StorageErrorEnum {
  NotFound = "StorageError: NotFound",
  NotSupported = "StorageError: NotSupported",
  InvalidArgument = "StorageError: InvalidArgument",
  Internal = "StorageError: Internal",
}
export class StorageError extends Error {
  constructor(message: string, public readonly code: StorageErrorEnum) {
    super(message)
  }
}

export interface IStorage {
  upload(file: File): Promise<string>
  download(url: string): Promise<File>
  delete(url: string): Promise<void>
  list(prefix: string): Promise<string[]>
  search(prefix: string): Promise<string[]>
  get(url: string): Promise<File>
} 