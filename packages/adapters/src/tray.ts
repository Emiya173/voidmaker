import dbus from "dbus-next";
import type { DiagnosticResult } from "../../contracts/src/settings.js";

const watcherName = "org.kde.StatusNotifierWatcher";
const itemPath = "/StatusNotifierItem";
export const trayName = `org.kde.StatusNotifierItem-${process.pid}-1`;
class TrayItem extends dbus.interface.Interface {
  readonly Category = "ApplicationStatus";
  readonly Id = "voidmaker";
  readonly Title = "VoidMaker";
  readonly Status = "Active";
  readonly WindowId = 0;
  readonly IconName = "face-smile";
  readonly IconPixmap: unknown[] = [];
  readonly OverlayIconName = "";
  readonly OverlayIconPixmap: unknown[] = [];
  readonly AttentionIconName = "";
  readonly AttentionIconPixmap: unknown[] = [];
  readonly AttentionMovieName = "";
  readonly ItemIsMenu = false;
  readonly Menu = "/";
  readonly ToolTip = ["face-smile", [], "VoidMaker", "左键显示/隐藏；右键打开设置"];
  constructor(private readonly activate: (settings: boolean) => void) {
    super("org.kde.StatusNotifierItem");
  }
  Activate(): void {
    this.activate(false);
  }
  SecondaryActivate(): void {
    this.activate(false);
  }
  ContextMenu(): void {
    this.activate(true);
  }
  Scroll(): void {}
}
TrayItem.configureMembers({
  properties: Object.fromEntries(
    Object.entries({
      Category: "s",
      Id: "s",
      Title: "s",
      Status: "s",
      WindowId: "u",
      IconName: "s",
      IconPixmap: "a(iiay)",
      OverlayIconName: "s",
      OverlayIconPixmap: "a(iiay)",
      AttentionIconName: "s",
      AttentionIconPixmap: "a(iiay)",
      AttentionMovieName: "s",
      ItemIsMenu: "b",
      Menu: "o",
      ToolTip: "(sa(iiay)ss)",
    }).map(([name, signature]) => [name, { signature, access: dbus.interface.ACCESS_READ }]),
  ),
  methods: {
    Activate: { inSignature: "ii", outSignature: "" },
    SecondaryActivate: { inSignature: "ii", outSignature: "" },
    ContextMenu: { inSignature: "ii", outSignature: "" },
    Scroll: { inSignature: "is", outSignature: "" },
  },
});
export class TrayService {
  private bus: dbus.MessageBus | undefined;
  private closed = false;
  private generation = 0;
  private state: DiagnosticResult = {
    id: "tray",
    label: "系统托盘",
    status: "unconfigured",
    detail: "尚未连接会话总线",
  };
  constructor(private readonly activate: (settings: boolean) => void) {}
  get status(): DiagnosticResult {
    return this.state;
  }
  start(): void {
    if (process.env.VOIDMAKER_TRAY === "0" || !process.env.DBUS_SESSION_BUS_ADDRESS) return;
    try {
      const bus = dbus.sessionBus();
      this.bus = bus;
      bus.on("error", () => {
        if (!this.closed)
          this.state = {
            id: "tray",
            label: "系统托盘",
            status: "error",
            detail: "会话总线连接失败；可用快捷键打开界面",
          };
      });
      bus.export(
        itemPath,
        new TrayItem((settings) => {
          if (!this.closed) this.activate(settings);
        }),
      );
      void this.connect(bus).catch(() => {
        if (!this.closed)
          this.state = { id: "tray", label: "系统托盘", status: "error", detail: "托盘连接失败；可用快捷键打开界面" };
      });
    } catch {
      this.state = { id: "tray", label: "系统托盘", status: "error", detail: "无法连接会话总线" };
    }
  }
  private async connect(bus: dbus.MessageBus): Promise<void> {
    await this.deadline(bus.requestName(trayName, 4));
    const daemon = (
      await this.deadline(bus.getProxyObject("org.freedesktop.DBus", "/org/freedesktop/DBus"))
    ).getInterface("org.freedesktop.DBus");
    daemon.on("NameOwnerChanged", (name: string, _old: string, owner: string) => {
      if (name !== watcherName || this.closed) return;
      if (owner) void this.register(bus);
      else {
        this.generation++;
        this.state = {
          id: "tray",
          label: "系统托盘",
          status: "unconfigured",
          detail: "桌面托盘宿主未运行；可用快捷键",
        };
      }
    });
    await this.register(bus);
  }
  private async register(bus: dbus.MessageBus): Promise<void> {
    const generation = ++this.generation;
    try {
      const watcher = (await this.deadline(bus.getProxyObject(watcherName, "/StatusNotifierWatcher"))).getInterface(
        watcherName,
      );
      if (this.closed || generation !== this.generation) return;
      const register = watcher.RegisterStatusNotifierItem;
      if (!register) throw new Error("Invalid tray watcher");
      await this.deadline(register.call(watcher, trayName));
      if (!this.closed && generation === this.generation)
        this.state = { id: "tray", label: "系统托盘", status: "ready", detail: "已向桌面托盘宿主注册" };
    } catch {
      if (!this.closed && generation === this.generation)
        this.state = {
          id: "tray",
          label: "系统托盘",
          status: "unconfigured",
          detail: "桌面托盘宿主不可用；可用快捷键，宿主启动后自动注册",
        };
    }
  }
  private async deadline<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("D-Bus timeout")), 3000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  close(): void {
    this.closed = true;
    this.generation++;
    this.bus?.disconnect();
  }
}
