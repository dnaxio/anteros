import type { Document, ChangeStreamOptions, ChangeStream } from "mongodb";

export class Test {
  #tenant!: { id: string };
  @Check()
  async watch(collection: string, pipeline: any[], options: ChangeStreamOptions): Promise<ChangeStream> {
    return undefined as any;
  }
  @Check()
  async find(collection: string, params: any = {}, options = {}): Promise<Document[]> {
    return [];
  }
}

function Check() { return (target: any, key: string) => {} }
