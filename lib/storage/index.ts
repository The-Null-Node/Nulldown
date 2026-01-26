import { staticStorage } from "./staticstorage";
import { bucketStorage } from "./bucketstorage";
import { IStorage } from "./storage";

const storageModeMap: Record<string, IStorage> = {
  static: staticStorage,
  bucket: bucketStorage,
};

export { staticStorage as storage };
