export const DROP_ID_LENGTH = 12;
export const DROP_LINK_ID_LENGTH = 6;

const DROP_ID_ALPHABET =
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const MAX_ACCEPTABLE_RANDOM_BYTE = 256 - (256 % DROP_ID_ALPHABET.length);
const DROP_ID_TOKEN_REGEX = /^[A-Za-z0-9_-]+$/;

const randomInt = (max: number) => Math.floor(Math.random() * max);

export const generateDropId = (length = DROP_ID_LENGTH): string => {
  if (length <= 0) {
    return "";
  }

  if (
    typeof crypto !== "undefined" &&
    typeof crypto.getRandomValues === "function"
  ) {
    let output = "";

    while (output.length < length) {
      const randomBytes = new Uint8Array(length * 2);
      crypto.getRandomValues(randomBytes);

      randomBytes.forEach((value) => {
        if (output.length >= length) {
          return;
        }

        if (value >= MAX_ACCEPTABLE_RANDOM_BYTE) {
          return;
        }

        output += DROP_ID_ALPHABET[value % DROP_ID_ALPHABET.length];
      });
    }

    return output;
  }

  let output = "";
  for (let index = 0; index < length; index += 1) {
    output += DROP_ID_ALPHABET[randomInt(DROP_ID_ALPHABET.length)];
  }

  return output;
};

export const toShortDropId = (id: string): string =>
  id.slice(0, DROP_LINK_ID_LENGTH);

export const isShortDropId = (id: string): boolean =>
  id.length === DROP_LINK_ID_LENGTH && DROP_ID_TOKEN_REGEX.test(id);

export const isDropIdToken = (id: string): boolean =>
  id.length > 0 && DROP_ID_TOKEN_REGEX.test(id);
