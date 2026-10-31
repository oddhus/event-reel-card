import type { HassEntity, HomeAssistant } from "../src/ha-types";

export type WsHandler = (msg: Record<string, unknown>) => unknown | Promise<unknown>;

export type MockOptions = {
  language: string;
  darkMode: boolean;
  states: Record<string, HassEntity>;
  handlers: Record<string, WsHandler>;
};

// A small stand-in for HA's translated state names.
const STATE_NAMES: Record<string, Record<string, string>> = {
  en: {
    on: "Open",
    off: "Closed",
    locked: "Locked",
    unlocked: "Unlocked",
    home: "Home",
    not_home: "Away",
  },
  nb: {
    on: "Åpen",
    off: "Lukket",
    locked: "Låst",
    unlocked: "Ulåst",
    home: "Hjemme",
    not_home: "Borte",
  },
};

export function createMockHass(opts: MockOptions): HomeAssistant {
  const handlers: Record<string, WsHandler> = {
    "auth/sign_path": (msg) => {
      const path = String(msg.path);
      return { path: `${path}${path.includes("?") ? "&" : "?"}authSig=dev` };
    },
    ...opts.handlers,
  };

  return {
    states: opts.states,
    entities: {},
    devices: {},
    services: {},
    config: { time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone, components: [] },
    locale: { language: opts.language, time_format: "24" },
    language: opts.language,
    themes: { darkMode: opts.darkMode },
    user: { id: "dev", name: "Dev", is_admin: true },
    connection: {
      subscribeMessage: async () => () => undefined,
    },
    async callWS<T>(msg: Record<string, unknown>): Promise<T> {
      const key =
        msg.type === "call_service"
          ? `call_service:${msg.domain}.${msg.service}`
          : String(msg.type);
      const handler = handlers[key];
      if (!handler) {
        console.warn("[mock-hass] unhandled", msg);
        throw { code: "unknown_command", message: `Unhandled ${key}` };
      }
      return (await handler(msg)) as T;
    },
    async callService() {
      return undefined;
    },
    async callApi<T>(): Promise<T> {
      throw new Error("callApi not mocked");
    },
    formatEntityState: (stateObj, state) => {
      const s = state ?? stateObj.state;
      return STATE_NAMES[opts.language]?.[s] ?? s;
    },
  };
}
