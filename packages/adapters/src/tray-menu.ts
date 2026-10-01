import dbus from "dbus-next";
import type { TrayAction } from "../../contracts/src/shell.js";

export const trayMenuPath = "/StatusNotifierItem/Menu";
type Properties = Record<string, dbus.Variant>;
type Layout = [number, Properties, dbus.Variant<Layout>[]];
type Entry = Readonly<{ id: number; label: string; action: TrayAction }> | Readonly<{ id: number; separator: true }>;
const entries: readonly Entry[] = [
  { id: 1, label: "显示/隐藏 VoidMaker", action: { type: "toggle" } },
  { id: 10, separator: true },
  { id: 3, label: "对话", action: { type: "open", page: "chat" } },
  { id: 4, label: "后台任务", action: { type: "open", page: "work" } },
  { id: 5, label: "会话与记忆", action: { type: "open", page: "history" } },
  { id: 6, label: "桌面感知", action: { type: "open", page: "desktop" } },
  { id: 11, separator: true },
  { id: 7, label: "停止当前对话（含语音）", action: { type: "stop" } },
  { id: 12, separator: true },
  { id: 2, label: "设置", action: { type: "open", page: "settings" } },
  { id: 8, label: "服务诊断", action: { type: "open", page: "diagnostics" } },
  { id: 13, separator: true },
  { id: 9, label: "退出 VoidMaker", action: { type: "exit" } },
];
const validId = (id: number): boolean => id === 0 || entries.some((entry) => entry.id === id);
const requireId = (id: number): void => {
  if (!validId(id)) throw new dbus.DBusError("com.canonical.dbusmenu.Error.InvalidMenuItem", "Unknown menu item");
};
const properties = (id: number, names: readonly string[]): Properties => {
  requireId(id);
  const entry = entries.find((entry) => entry.id === id);
  const all: Properties = entry
    ? "separator" in entry
      ? { type: new dbus.Variant("s", "separator") }
      : {
          label: new dbus.Variant("s", entry.label),
          enabled: new dbus.Variant("b", true),
          visible: new dbus.Variant("b", true),
        }
    : { "children-display": new dbus.Variant("s", "submenu") };
  return Object.fromEntries(Object.entries(all).filter(([name]) => names.length === 0 || names.includes(name)));
};

// Static DBusMenu: opening/hovering never activates an action; only a clicked leaf does.
export class TrayMenu extends dbus.interface.Interface {
  readonly Version = 3;
  readonly TextDirection = "ltr";
  readonly Status = "normal";
  readonly IconThemePath: string[] = [];
  constructor(private readonly activate: (action: TrayAction) => void) {
    super("com.canonical.dbusmenu");
  }
  GetLayout(parentId: number, depth: number, names: string[]): [number, Layout] {
    const props = properties(parentId, names);
    const children =
      parentId === 0 && depth !== 0
        ? entries.map((entry) => new dbus.Variant<Layout>("(ia{sv}av)", [entry.id, properties(entry.id, names), []]))
        : [];
    return [1, [parentId, props, children]];
  }
  GetGroupProperties(ids: number[], names: string[]): [number, Properties][] {
    return (ids.length ? ids : [0, ...entries.map((entry) => entry.id)])
      .filter(validId)
      .map((id) => [id, properties(id, names)]);
  }
  GetProperty(id: number, name: string): dbus.Variant {
    const value = properties(id, [name])[name];
    if (!value) throw new dbus.DBusError("com.canonical.dbusmenu.Error.UnknownProperty", "Unknown menu property");
    return value;
  }
  Event(id: number, event: string, _data: dbus.Variant, _timestamp: number): void {
    requireId(id);
    const entry = entries.find((entry) => entry.id === id);
    if (entry && "action" in entry && event === "clicked") this.activate(entry.action);
  }
  EventGroup(events: [number, string, dbus.Variant, number][]): number[] {
    const errors: number[] = [];
    for (const event of events) {
      if (validId(event[0])) this.Event(...event);
      else errors.push(event[0]);
    }
    return errors;
  }
  AboutToShow(id: number): boolean {
    requireId(id);
    return false;
  }
  AboutToShowGroup(ids: number[]): [number[], number[]] {
    return [[], ids.filter((id) => !validId(id))];
  }
  LayoutUpdated(revision: number, parent: number): [number, number] {
    return [revision, parent];
  }
  ItemsPropertiesUpdated(updated: [number, Properties][], removed: [number, string[]][]): unknown[] {
    return [updated, removed];
  }
  ItemActivationRequested(id: number, timestamp: number): [number, number] {
    return [id, timestamp];
  }
}
TrayMenu.configureMembers({
  properties: {
    Version: { signature: "u", access: dbus.interface.ACCESS_READ },
    TextDirection: { signature: "s", access: dbus.interface.ACCESS_READ },
    Status: { signature: "s", access: dbus.interface.ACCESS_READ },
    IconThemePath: { signature: "as", access: dbus.interface.ACCESS_READ },
  },
  methods: {
    GetLayout: { inSignature: "iias", outSignature: "u(ia{sv}av)" },
    GetGroupProperties: { inSignature: "aias", outSignature: "a(ia{sv})" },
    GetProperty: { inSignature: "is", outSignature: "v" },
    Event: { inSignature: "isvu", outSignature: "" },
    EventGroup: { inSignature: "a(isvu)", outSignature: "ai" },
    AboutToShow: { inSignature: "i", outSignature: "b" },
    AboutToShowGroup: { inSignature: "ai", outSignature: "aiai" },
  },
  signals: {
    LayoutUpdated: { signature: "ui" },
    ItemsPropertiesUpdated: { signature: "a(ia{sv})a(ias)" },
    ItemActivationRequested: { signature: "iu" },
  },
});
