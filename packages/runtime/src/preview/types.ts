export type WebFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
export type FetchHandler = (request: Request) => Response | Promise<Response>
