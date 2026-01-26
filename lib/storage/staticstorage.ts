import { IStorage } from "./storage";

interface IStaticStorage extends IStorage {
  upload: (file: File) => Promise<string>;
  download: (url: string) => Promise<File>;
  delete: (url: string) => Promise<void>;
  list: (prefix: string) => Promise<string[]>;
  search: (prefix: string) => Promise<string[]>;
  get: (url: string) => Promise<File>;
}

export const staticStorage: IStaticStorage = {
  upload: async (file: File) => {
    return file.name;
  },
  download: async (url: string) => {
    return new File([], url);
  },
  delete: async (url: string) => {
    return;
  },
  list: async (prefix: string) => {
    return [];
  },
  search: async (prefix: string) => {
    return [];
  },
  get: async (url: string) => {
    return new File([], url);
  },
};
