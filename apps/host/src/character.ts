import {
  type Character,
  type CharacterCatalog,
  characterSummary,
  defaultCharacter,
} from "../../../packages/adapters/src/characters.js";
import type { CharacterSnapshot } from "../../../packages/contracts/src/character.js";
import type { VoiceSnapshot } from "../../../packages/contracts/src/voice.js";
import { characterPresentation } from "../../../packages/domain/src/character.js";

type Binding = Readonly<{ sessionId: string; threadId: string }>;
type Ports = Readonly<{
  idle: () => boolean;
  prepare: (character: Character, signal: AbortSignal, sessionId?: string) => Promise<Binding>;
  persist: (id: string, binding: Binding) => Promise<void>;
  publish: () => void;
}>;
export class CharacterController {
  current: Character = defaultCharacter;
  binding: Binding = { sessionId: "", threadId: "" };
  changing = false;
  private readonly controller = new AbortController();
  private pending: Promise<void> = Promise.resolve();
  constructor(
    readonly catalog: CharacterCatalog,
    private readonly ports: Ports,
  ) {}
  snapshot(voice: VoiceSnapshot, thinking: boolean): CharacterSnapshot {
    return {
      selectedId: this.current.id,
      sessionId: this.binding.sessionId,
      characters: this.catalog.entries.map(characterSummary),
      changing: this.changing,
      warnings: this.catalog.warnings,
      presentation: {
        ...characterPresentation(this.current.portraits, voice, thinking, this.current.layered),
        ...(this.current.avatar ? { avatar: this.current.avatar } : {}),
      },
    };
  }
  select(id: string, session?: string | (() => Promise<string>)): Promise<void> {
    this.controller.signal.throwIfAborted();
    if (this.changing || !this.ports.idle()) throw new Error("请先停止当前对话或录音，再切换角色");
    const character = this.catalog.entries.find((entry) => entry.id === id);
    if (!character) throw new Error("角色不存在或配置无效");
    if (!session && this.current === character && this.binding.threadId) return Promise.resolve();
    return this.edit((signal) => this.change(character, signal, session));
  }
  edit(effect: (signal: AbortSignal) => Promise<void>): Promise<void> {
    this.controller.signal.throwIfAborted();
    if (this.changing || !this.ports.idle()) throw new Error("请先停止当前对话或录音，再修改会话或记忆");
    this.changing = true;
    this.ports.publish();
    this.pending = this.perform(effect);
    return this.pending;
  }
  private async change(
    character: Character,
    signal: AbortSignal,
    session?: string | (() => Promise<string>),
  ): Promise<void> {
    const sessionId = typeof session === "function" ? await session() : session;
    signal.throwIfAborted();
    const binding = await this.ports.prepare(character, signal, sessionId);
    this.controller.signal.throwIfAborted();
    await this.ports.persist(character.id, binding);
    this.controller.signal.throwIfAborted();
    this.current = character;
    this.binding = binding;
  }
  private async perform(effect: (signal: AbortSignal) => Promise<void>): Promise<void> {
    try {
      await effect(this.controller.signal);
    } finally {
      this.changing = false;
      if (!this.controller.signal.aborted) this.ports.publish();
    }
  }
  async close(): Promise<void> {
    this.controller.abort();
    await this.pending.catch(() => undefined);
  }
}
