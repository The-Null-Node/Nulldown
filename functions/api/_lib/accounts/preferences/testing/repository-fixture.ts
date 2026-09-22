import { jest } from "@jest/globals";

import type { AccountPreferenceRow } from "../repository";

export const createAccountPreferenceDatabase = (row: AccountPreferenceRow) => {
  const writeStatement = {
    bind: jest.fn(),
    run: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
  };
  writeStatement.bind.mockReturnValue(writeStatement);
  const readStatement = {
    bind: jest.fn(),
    first: jest
      .fn<() => Promise<AccountPreferenceRow>>()
      .mockResolvedValue(row),
  };
  readStatement.bind.mockReturnValue(readStatement);
  const prepare = jest
    .fn()
    .mockReturnValueOnce(writeStatement)
    .mockReturnValueOnce(readStatement);
  return { prepare, writeStatement, readStatement };
};
