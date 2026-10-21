import { isHostTransportError } from "@/lib/ui-error";

export interface ApiJsonOptions {
  fallback: string;
}

function responseError(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null || !("error" in data)) return undefined;
  const error = (data as { error?: unknown }).error;
  return error ? String(error) : undefined;
}

export async function apiJson<T>(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  options: ApiJsonOptions,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch {
    throw new Error(options.fallback);
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error(options.fallback);
  }

  if (!response.ok) {
    const message = responseError(data);
    // 底层管道/套接字噪声（如 connect ENOENT \.\pipe\piforge-agent-…）不是
    // 用户能处理的错误：降级成本次调用的友好兜底文案，避免它出现在红字里。
    if (message && isHostTransportError(message)) {
      throw new Error(options.fallback);
    }
    throw new Error(message ?? options.fallback);
  }
  return data as T;
}
