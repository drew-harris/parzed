declare module "nrepl-client" {
  import { Socket } from "net";

  interface ConnectOptions {
    port: number;
    host?: string;
  }

  interface EvalResult {
    id?: string;
    session?: string;
    ns?: string;
    value?: string;
    out?: string;
    err?: string;
    ex?: string;
    "root-ex"?: string;
    status?: string[];
  }

  interface NREPLConnection extends Socket {
    eval(
      code: string,
      callback: (err: Error | null, result: EvalResult[]) => void,
    ): void;
    eval(
      code: string,
      session: string | null,
      id: string | null,
      evalFunc: string | null,
      callback: (err: Error | null, result: EvalResult[]) => void,
    ): void;
    clone(callback: (err: Error | null, result: EvalResult[]) => void): void;
    close(callback: (err: Error | null, result: EvalResult[]) => void): void;
    describe(callback: (err: Error | null, result: EvalResult[]) => void): void;
    interrupt(
      session: string,
      id: string,
      callback: (err: Error | null, result: EvalResult[]) => void,
    ): void;
    loadFile(
      fileContent: string,
      fileName: string | null,
      filePath: string | null,
      callback: (err: Error | null, result: EvalResult[]) => void,
    ): void;
    lsSessions(callback: (err: Error | null, result: EvalResult[]) => void): void;
    stdin(
      stdin: string,
      callback: (err: Error | null, result: EvalResult[]) => void,
    ): void;
    send(
      msg: object,
      callback: (err: Error | null, result: EvalResult[]) => void,
    ): void;
  }

  export function connect(options: ConnectOptions): NREPLConnection;
}
