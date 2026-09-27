declare module "mmd-parser" {
  export class Parser {
    parsePmx(buffer: ArrayBuffer, leftToRight: boolean): unknown;
  }
}
