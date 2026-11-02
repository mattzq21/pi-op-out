export interface SearchRequest {
  modelId: string;
  baseUrl: string;
  apiKey: string;
  headers: Headers;
  query: string;
  domains: string[];
  instructions: string;
}

export type RawSource = { url?: unknown; title?: unknown };

export type Post = (url: string, headers: Headers, body: unknown) => Promise<string>;

export interface SearchBackend {
  api: string;
  account: string;
  accepts(apiKey: string): boolean;
  search(request: SearchRequest, post: Post): Promise<{ answer: string; sources: RawSource[] }>;
}
