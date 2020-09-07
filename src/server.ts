import * as path from "path";
import {
  createConnection,
  TextDocuments,
  Diagnostic,
  DiagnosticSeverity,
  ProposedFeatures,
  InitializeParams,
  TextDocumentSyncKind,
  InitializeResult,
} from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";
import { lint } from "stylelint";
import { take, get } from "lodash";

import propertiesOrder from "./properties-order";

const connection = createConnection(ProposedFeatures.all);
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);
let hasConfigurationCapability: boolean = false;
let hasWorkspaceFolderCapability: boolean = false;
let hasDiagnosticRelatedInformationCapability: boolean = false;

connection.onInitialize((params: InitializeParams) => {
  let capabilities = params.capabilities;

  hasConfigurationCapability = !!(
    capabilities.workspace && !!capabilities.workspace.configuration
  );
  hasWorkspaceFolderCapability = !!(
    capabilities.workspace && !!capabilities.workspace.workspaceFolders
  );
  hasDiagnosticRelatedInformationCapability = !!(
    capabilities.textDocument &&
    capabilities.textDocument.publishDiagnostics &&
    capabilities.textDocument.publishDiagnostics.relatedInformation
  );

  const result: InitializeResult = {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
    },
  };
  if (hasWorkspaceFolderCapability) {
    result.capabilities.workspace = {
      workspaceFolders: {
        supported: true,
      },
    };
  }
  return result;
});

interface RecessSettings {
  stylelintRules: object;
}
const defaultSettings: RecessSettings = { stylelintRules: {} };
let globalSettings: RecessSettings = defaultSettings;

// Cache the settings of all open documents
const documentSettings: Map<string, Thenable<RecessSettings>> = new Map();

connection.onDidChangeConfiguration((change) => {
  if (hasConfigurationCapability) {
    // Reset all cached document settings
    documentSettings.clear();
  } else {
    globalSettings = <RecessSettings>(
      (change.settings.recess || defaultSettings)
    );
  }

  // Revalidate all open text documents
  documents.all().forEach(validateTextDocument);
});

function getDocumentSettings(resource: string): Thenable<RecessSettings> {
  if (!hasConfigurationCapability) {
    return Promise.resolve(globalSettings);
  }
  let result = documentSettings.get(resource);
  if (!result) {
    result = connection.workspace.getConfiguration({
      scopeUri: resource,
      section: "recess",
    });
    documentSettings.set(resource, result);
  }
  return result;
}

// Only keep settings for open documents
documents.onDidClose((e) => {
  documentSettings.delete(e.document.uri);
});

documents.onDidChangeContent((change) => {
  validateTextDocument(change.document);
});

async function validateTextDocument(textDocument: TextDocument): Promise<void> {
  const settings = await getDocumentSettings(textDocument.uri);
  const text = textDocument.getText();
  let diagnostics: Diagnostic[] = [];

  await lint({
    code: text,
    configBasedir: path.resolve(__dirname, "../node_modules"),
    config: {
      extends: "stylelint-config-standard",
      plugins: ["stylelint-order"],
      rules: {
        "order/order": ["custom-properties", "declarations"],
        "order/properties-order": propertiesOrder,
        ...get(settings, "stylelintRules", {}),
      },
    },
  }).then((result) => {
    result.results.forEach((result) => {
      result.warnings.forEach((warning) => {
        const lines = text.split("\n");
        const linesStart = take(lines, warning.line - 1);
        const line = lines[warning.line - 1];
        const start =
          linesStart.reduce((cur, acc) => acc.length + cur, 0) +
          warning.line +
          warning.column -
          2;
        const end = start + (line.length - warning.column);

        let diagnostic: Diagnostic = {
          severity: DiagnosticSeverity.Warning,
          range: {
            start: textDocument.positionAt(start),
            end: textDocument.positionAt(end),
          },
          message: warning.text,
          source: "recess",
        };

        diagnostics.push(diagnostic);
      });
    });
  });

  connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

documents.listen(connection);
connection.listen();
