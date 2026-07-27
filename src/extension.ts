import * as path from "path";
import { commands, ExtensionContext, window } from "vscode";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";

let client: LanguageClient | undefined;

export async function activate(context: ExtensionContext): Promise<void> {
  const serverModule = context.asAbsolutePath(path.join("out", "server", "main.js"));

  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: { execArgv: ["--nolazy", "--inspect=6009"] },
    },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "compact" }],
    synchronize: {
      configurationSection: "niteCompact",
    },
  };

  client = new LanguageClient("niteCompact", "Nite Compact Language Server", serverOptions, clientOptions);

  context.subscriptions.push(
    commands.registerCommand("niteCompact.restartServer", async () => {
      if (client) {
        await client.restart();
        window.setStatusBarMessage("Nite Compact: language server restarted", 3000);
      }
    }),
    commands.registerCommand("niteCompact.checkFile", () => {
      const editor = window.activeTextEditor;
      if (editor && editor.document.languageId === "compact" && client) {
        void client.sendNotification("niteCompact/checkFile", editor.document.uri.toString());
      }
    }),
  );

  await client.start();
}

export async function deactivate(): Promise<void> {
  if (client) {
    await client.stop();
    client = undefined;
  }
}
