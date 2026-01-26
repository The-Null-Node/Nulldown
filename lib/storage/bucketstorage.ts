import { IStorage } from "./storage";

export const bucketStorage: IStorage = {
  upload: async (file: File) => {
    return file.name;
  },

  get: async (url: string) => {
    return new File([], url);
  },

  delete: async (url: string) => {
    return Promise.resolve();
  },

  list: async () => {
    return [];
  },
  download: async (url: string) => {
    return new File([], url);
  },

  search: async (query: string) => {
    return [];
  },
};
