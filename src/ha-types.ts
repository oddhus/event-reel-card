// The parts of Home Assistant's frontend `hass` object this card uses. Kept small on
// purpose so the card does not depend on a typings package that lags behind HA.

export type HassContext = {
  id: string;
  parent_id: string | null;
  user_id: string | null;
};

export type HassEntity = {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown> & { friendly_name?: string; icon?: string };
  last_changed: string;
  last_updated: string;
  context?: HassContext;
};

export type HassEntityRegistryEntry = {
  entity_id: string;
  device_id?: string | null;
  platform?: string;
  area_id?: string | null;
  name?: string | null;
  hidden?: boolean;
};

export type HassDevice = {
  id: string;
  name?: string | null;
  name_by_user?: string | null;
  area_id?: string | null;
};

export type HassLocale = {
  language: string;
  number_format?: string;
  time_format?: "language" | "system" | "12" | "24";
  time_zone?: "local" | "server";
};

export type HassConfig = {
  time_zone: string;
  components: string[];
  language?: string;
};

export type HassUser = {
  id: string;
  name: string;
  is_admin: boolean;
};

export type Unsubscribe = () => Promise<void> | void;

export type HassConnection = {
  subscribeMessage<T>(
    callback: (message: T) => void,
    subscribeMessage: Record<string, unknown>,
  ): Promise<Unsubscribe>;
  addEventListener?(event: "ready" | "disconnected", cb: () => void): void;
  removeEventListener?(event: "ready" | "disconnected", cb: () => void): void;
};

export type HomeAssistant = {
  states: Record<string, HassEntity>;
  entities: Record<string, HassEntityRegistryEntry>;
  devices: Record<string, HassDevice>;
  services: Record<string, Record<string, unknown>>;
  config: HassConfig;
  locale: HassLocale;
  language: string;
  themes?: { darkMode?: boolean };
  user?: HassUser;
  connection: HassConnection;
  callWS<T>(msg: Record<string, unknown>): Promise<T>;
  callService(
    domain: string,
    service: string,
    data?: Record<string, unknown>,
    target?: Record<string, unknown>,
  ): Promise<unknown>;
  callApi<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, data?: unknown): Promise<T>;
  formatEntityState?(stateObj: HassEntity, state?: string): string;
};
