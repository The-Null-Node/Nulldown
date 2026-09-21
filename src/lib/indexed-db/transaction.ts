/** Converts one IndexedDB request into a promise with a stable failure message. */
export const requestToPromise = <T>(
  request: IDBRequest<T>,
  message: string,
): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        request.error
          ? new Error(`${message}: ${request.error.message}`)
          : new Error(message),
      );
  });

/** Waits for one IndexedDB transaction to commit or fail. */
export const waitForTransaction = (
  transaction: IDBTransaction,
): Promise<void> =>
  new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(
        transaction.error
          ? new Error(
              `IndexedDB transaction failed: ${transaction.error.message}`,
            )
          : new Error("IndexedDB transaction failed"),
      );
    transaction.onabort = () =>
      reject(
        transaction.error
          ? new Error(
              `IndexedDB transaction aborted: ${transaction.error.message}`,
            )
          : new Error("IndexedDB transaction aborted"),
      );
  });

/** Aborts an active transaction without masking the original operation error. */
export const abortTransaction = (transaction: IDBTransaction): void => {
  try {
    transaction.abort();
  } catch {
    // The transaction may already have aborted after a failed request.
  }
};
