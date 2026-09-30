import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { voiceConfigSchema } from "../packages/contracts/src/voice.js";

it.skipIf(process.env.VOIDMAKER_SHELL_SMOKE !== "1")(
  "renders settings and preserves unsaved fields across diagnostics and failed saves",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "voidmaker-settings-shell-"));
    const config = voiceConfigSchema.parse({
      inputTarget: "mic",
      aec: { pluginDirectory: "/plugin", outputTarget: "speaker", bargeIn: true },
      asr: { url: "http://127.0.0.1:8000/v1/audio/transcriptions" },
      tts: {
        provider: "gpt-sovits",
        url: "http://127.0.0.1:9880/tts",
        refAudioPath: "/reference.wav",
        promptText: "reference",
        textLanguage: "ja",
        model: { gptWeightsPath: "/default.ckpt", sovitsWeightsPath: "/default.pth" },
      },
    });
    await copyFile("apps/shell/SettingsPanel.qml", join(dir, "SettingsPanel.qml"));
    await writeFile(
      join(dir, "shell.qml"),
      `import QtQuick
import Quickshell
ShellRoot { FloatingWindow { visible:true;width:500;height:700
 SettingsPanel { id:panel;anchors.fill:parent;online:true;canEdit:true }
 Timer { interval:100;running:true;onTriggered:{
  const config=${JSON.stringify(config)}
  panel.receive({type:"settings",settings:{revision:"r1",config:config,busy:false,error:"",canRestore:false}})
  if(JSON.stringify(panel.config()) !== JSON.stringify(config)) {
    if(panel.config().aec.settings.nearendHold !== config.aec.settings.nearendHold || panel.config().inputTarget !== "mic") throw new Error("lost advanced config")
  }
  if(JSON.stringify(panel.config().tts) !== JSON.stringify(config.tts)) {
    const actual=panel.config().tts
    if(actual.provider !== "gpt-sovits" || JSON.stringify(actual.model) !== JSON.stringify(config.tts.model) || actual.textLanguage !== "ja") throw new Error("lost shared TTS model configuration")
  }
  panel.dirty=true
  panel.receive({type:"settings",settings:{revision:"r1",config:config,busy:true}})
  panel.receive({type:"settings",settings:{revision:"r1",config:config,busy:false}})
  if(!panel.dirty) throw new Error("lost dirty state")
  panel.receive({type:"settings",settings:{revision:"r2",config:config,busy:false}})
  if(!panel.dirty || panel.formRevision !== "r1") throw new Error("stale form revision lost")
  panel.receive({type:"diagnostics",diagnostics:{phase:"complete",checkedAt:"today",devices:[],results:[{id:"asr",label:"ASR",status:"warming",detail:"warmup"}]}})
  if(!panel.dirty) throw new Error("diagnostic changed form")
  panel.currentSection=1
 } }
 Timer {interval:600;running:true;onTriggered:{ console.log("SETTINGS_RENDERED");Qt.quit() } }
} }`,
    );
    let log = "";
    const child = spawn("quickshell", ["--path", join(dir, "shell.qml")], {
      env: { ...process.env, QT_QPA_PLATFORM: "offscreen" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (data) => {
      log += data;
    });
    child.stderr.on("data", (data) => {
      log += data;
    });
    try {
      await expect.poll(() => log, { timeout: 5000 }).toContain("SETTINGS_RENDERED");
      expect(log).not.toMatch(/ReferenceError|TypeError|Error:|Failed to load|Cannot assign|Binding loop/);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, "close");
        child.kill("SIGTERM");
        await closed;
      }
      await rm(dir, { recursive: true });
    }
  },
  10000,
);
