type Persistor<T> = (value: T) => boolean;

interface Logger<T> {
  log(value: T): boolean;
  persist(cb: Persistor<T>): boolean;
}

const defaultLogger = createLogger();

export function getLogger() {}
