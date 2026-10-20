/** User-managed OpenAI-compatible / Ollama / gateway providers. */

export interface CustomProviderModel {
  id: string;
  name?: string;
}

export interface CustomProviderView {
  id: string;
  name: string;
  baseUrl: string;
  /** Pi API implementation, e.g. openai-completions or anthropic-messages. */
  api: string;
  hasApiKey: boolean;
  /** Never contains the secret; empty when an API key is stored. */
  apiKeyHint: string;
  models: CustomProviderModel[];
  updatedAt: number;
}

export interface CustomProviderInput {
  id: string;
  name?: string;
  baseUrl: string;
  api?: string;
  /** Omitted keeps the stored key; empty string clears it. */
  apiKey?: string;
  models: CustomProviderModel[];
}

export interface HostTransportInfo {
  /** WebSocket endpoint for plugin/streaming transport, or null when disabled. */
  wsUrl: string | null;
  wsPort: number | null;
  /** Authenticated connections currently attached to the bus. */
  wsClients: number;
}
