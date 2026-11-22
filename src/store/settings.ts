import { create } from "zustand";
import { providerById, type Provider, type ProviderId } from "../lib/llm/providers";
import type { LlmConfig } from "../lib/llm";

/**
 * AI provider settings. Everything lives in this browser: Cutir has no server.
 * - provider choice, URLs and models: localStorage
 * - API keys: localStorage when "Remember keys" is on, otherwise sessionStorage (gone when the tab closes)
 */

export type ProviderSettings = { baseUrl?: string; apiKey?: string; model?: string };

export type SettingsTab = "ai" | "assistant" | "editor" | "storage" | "project" | "system" | "shortcuts";

type State = {
  provider: ProviderId;
  byProvider: Partial<Record<ProviderId, ProviderSettings>>;
  rememberKeys: boolean;
  /** Open the AI panel whenever a project opens. Off by default. */
  showAiOnOpen: boolean;
  dialogOpen: boolean;
  tab: SettingsTab;

  setProvider: (id: ProviderId) => void;
  patch: (id: ProviderId, p: ProviderSettings) => void;
  setModel: (m: string) => void;
  setRememberKeys: (on: boolean) => void;
  setShowAiOnOpen: (on: boolean) => void;
  forgetKeys: () => void;
  openDialog: (tab?: SettingsTab) => void;
  setTab: (tab: SettingsTab) => void;
  closeDialog: () => void;
};

const SETTINGS_KEY = "cutir:llm";
const KEYS_KEY = "cutir:llmKeys";

const get = (s: Storage | undefined, k: string) => {
  try {
    return s?.getItem(k) ?? null;
  } catch {
    return null;
  }
};
const set = (s: Storage | undefined, k: string, v: string) => {
  try {
    s?.setItem(k, v);
  } catch {
    /* storage unavailable */
  }
};
const del = (s: Storage | undefined, k: string) => {
  try {
    s?.removeItem(k);
  } catch {
    /* storage unavailable */
  }
};
const local = typeof localStorage === "undefined" ? undefined : localStorage;
const session = typeof sessionStorage === "undefined" ? undefined : sessionStorage;

const parse = <T,>(raw: string | null, fallback: T): T => {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

type Saved = { provider?: ProviderId; rememberKeys?: boolean; showAiOnOpen?: boolean; byProvider?: Partial<Record<ProviderId, Omit<ProviderSettings, "apiKey">>> };

function load(): Pick<State, "provider" | "byProvider" | "rememberKeys" | "showAiOnOpen"> {
  const saved = parse<Saved>(get(local, SETTINGS_KEY), {});
  const rememberKeys = saved.rememberKeys ?? true;
  const keys = parse<Partial<Record<ProviderId, string>>>(get(rememberKeys ? local : session, KEYS_KEY), {});
  const byProvider: State["byProvider"] = {};
  for (const [id, v] of Object.entries(saved.byProvider ?? {})) byProvider[id as ProviderId] = { ...v };
  for (const [id, apiKey] of Object.entries(keys)) byProvider[id as ProviderId] = { ...byProvider[id as ProviderId], apiKey };

  // carry over the Ollama URL / model saved before provider settings existed
  const oldUrl = get(local, "cutir:ollamaUrl");
  const oldModel = get(local, "cutir:ollamaModel");
  if (!saved.byProvider?.ollama && (oldUrl || oldModel)) byProvider.ollama = { ...byProvider.ollama, baseUrl: oldUrl ?? undefined, model: oldModel ?? undefined };

  // nothing is chosen for a new user; people who already used Ollama keep it
  const hadOllama = !!(oldUrl || oldModel);
  return { provider: providerById(saved.provider ?? (hadOllama ? "ollama" : "none")).id, byProvider, rememberKeys, showAiOnOpen: saved.showAiOnOpen ?? false };
}

function save(s: Pick<State, "provider" | "byProvider" | "rememberKeys" | "showAiOnOpen">) {
  const meta: Saved["byProvider"] = {};
  const keys: Partial<Record<ProviderId, string>> = {};
  for (const [id, v] of Object.entries(s.byProvider) as [ProviderId, ProviderSettings][]) {
    const { apiKey, ...rest } = v;
    meta[id] = rest;
    if (apiKey) keys[id] = apiKey;
  }
  set(local, SETTINGS_KEY, JSON.stringify({ provider: s.provider, rememberKeys: s.rememberKeys, showAiOnOpen: s.showAiOnOpen, byProvider: meta } satisfies Saved));
  // keys go to exactly one place, and never to the other
  const [here, there] = s.rememberKeys ? [local, session] : [session, local];
  if (Object.keys(keys).length) set(here, KEYS_KEY, JSON.stringify(keys));
  else del(here, KEYS_KEY);
  del(there, KEYS_KEY);
}

export const useSettings = create<State>((setState, getState) => {
  const commit = (patch: Partial<Pick<State, "provider" | "byProvider" | "rememberKeys" | "showAiOnOpen">>) => {
    setState(patch);
    const s = getState();
    save({ provider: s.provider, byProvider: s.byProvider, rememberKeys: s.rememberKeys, showAiOnOpen: s.showAiOnOpen });
  };
  return {
    ...load(),
    dialogOpen: false,
    tab: "ai",

    setProvider: (provider) => commit({ provider }),
    patch: (id, p) => commit({ byProvider: { ...getState().byProvider, [id]: { ...getState().byProvider[id], ...p } } }),
    setModel: (model) => {
      const id = getState().provider;
      commit({ byProvider: { ...getState().byProvider, [id]: { ...getState().byProvider[id], model } } });
    },
    setRememberKeys: (rememberKeys) => commit({ rememberKeys }),
    setShowAiOnOpen: (showAiOnOpen) => commit({ showAiOnOpen }),
    forgetKeys: () => {
      const next: State["byProvider"] = {};
      for (const [id, v] of Object.entries(getState().byProvider) as [ProviderId, ProviderSettings][]) {
        const { apiKey: _key, ...rest } = v;
        void _key;
        next[id] = rest;
      }
      commit({ byProvider: next });
    },
    openDialog: (tab) => setState({ dialogOpen: true, ...(tab ? { tab } : {}) }),
    setTab: (tab) => setState({ tab }),
    closeDialog: () => setState({ dialogOpen: false }),
  };
});

/** Settings of one provider with the provider's defaults filled in. */
export function configFor(s: Pick<State, "byProvider">, id: ProviderId): LlmConfig {
  const provider: Provider = providerById(id);
  const v = s.byProvider[id] ?? {};
  return { provider, baseUrl: v.baseUrl ?? provider.baseUrl, apiKey: v.apiKey ?? "", model: v.model ?? "" };
}

/** The connection the chat uses right now. */
export const activeConfig = (): LlmConfig => {
  const s = useSettings.getState();
  return configFor(s, s.provider);
};

/** React hook form of `activeConfig`. */
export function useActiveConfig(): LlmConfig {
  const provider = useSettings((s) => s.provider);
  const byProvider = useSettings((s) => s.byProvider);
  return configFor({ byProvider }, provider);
}
