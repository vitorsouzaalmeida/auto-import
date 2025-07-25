import { basename, resolve } from "path";
import {
  createDocumentRegistry,
  createLanguageService,
  flattenDiagnosticMessageText,
  getDefaultLibFilePath,
  JsxEmit,
  ModuleKind,
  ModuleResolutionKind,
  resolveModuleName,
  ScriptSnapshot,
  ScriptTarget,
  sys,
  type CompilerOptions,
  type CompletionEntry,
  type Diagnostic,
  type LanguageService,
  type LanguageServiceHost,
} from "typescript";
import { parseArgs } from "util";

type MissingImport = {
  symbol: string;
  suggestedImports: string[];
};

type GroupedImport = {
  module: string;
  namedImports: string[];
  defaultImports: string[];
};

// I had issues with motion, so I added it here by now
const KNOWN_PACKAGE_IMPORTS: Record<string, string[]> = {
  motion: ['import { motion } from "motion/react";'],
};

const extractSymbolFromMessage = (message: string): string => {
  const symbolMatch = message.match(
    /Cannot find name '([^']+)'|'([^']+)' refers to a UMD global/
  );
  return symbolMatch ? symbolMatch[1] || symbolMatch[2] : "Unknown";
};

const cleanModulePath = (source: string): string => {
  if (!source.includes("node_modules")) return source;

  const match = source.match(/node_modules\/(@[^\/]+\/[^\/]+|[^\/]+)/);
  const moduleName = match?.[1] ?? source;

  if (moduleName.startsWith("@types/")) {
    return moduleName.replace("@types/", "");
  }

  return moduleName;
};

const formatImport = (name: string, source: string, kind: string): string =>
  kind === "module"
    ? `import ${name} from "${source}";`
    : `import { ${name} } from "${source}";`;

const extractImportsFromCompletions = (
  completions: CompletionEntry[],
  symbol: string
): string[] =>
  completions
    .filter((completion) => completion.hasAction && completion.name === symbol)
    .map((completion) =>
      completion.source
        ? formatImport(
            completion.name,
            cleanModulePath(completion.source),
            completion.kind
          )
        : null
    )
    .filter((imp): imp is string => imp !== null)
    .filter((imp, index, self) => self.indexOf(imp) === index)
    .slice(0, 5);

const processDiagnostic = (
  diagnostic: Diagnostic,
  filePath: string,
  languageService: LanguageService,
  processedSymbols: Set<string>
): MissingImport | null => {
  const message = flattenDiagnosticMessageText(diagnostic.messageText, "\n");

  const symbol = extractSymbolFromMessage(message);

  if (processedSymbols.has(symbol)) {
    return null;
  }

  const completions = languageService.getCompletionsAtPosition(
    filePath,
    diagnostic.start!,
    {
      includeCompletionsForModuleExports: true,
      includePackageJsonAutoImports: "auto",
      includeCompletionsWithInsertText: true,
      includeCompletionsForImportStatements: true,
    }
  );

  const autoImportCompletions = completions?.entries || [];
  const suggestedImports = extractImportsFromCompletions(
    autoImportCompletions,
    symbol
  );

  const finalSuggestedImports =
    suggestedImports.length === 0 && KNOWN_PACKAGE_IMPORTS[symbol]
      ? KNOWN_PACKAGE_IMPORTS[symbol]
      : suggestedImports;

  return { symbol, suggestedImports: finalSuggestedImports };
};

const groupImportsByModule = (
  missingImports: MissingImport[]
): GroupedImport[] => {
  const moduleMap = new Map<
    string,
    { named: Set<string>; default: Set<string> }
  >();

  missingImports.forEach(({ suggestedImports }) => {
    suggestedImports.forEach((importStatement) => {
      const defaultMatch = importStatement.match(
        /import\s+(\w+)\s+from\s+["']([^"']+)["'];?/
      );

      if (defaultMatch) {
        const [, importName, module] = defaultMatch;
        if (!moduleMap.has(module)) {
          moduleMap.set(module, { named: new Set(), default: new Set() });
        }
        moduleMap.get(module)!.default.add(importName);
        return;
      }

      const namedMatch = importStatement.match(
        /import\s+\{\s*([^}]+)\s*\}\s+from\s+["']([^"']+)["'];?/
      );

      if (namedMatch) {
        const [, imports, module] = namedMatch;
        if (!moduleMap.has(module)) {
          moduleMap.set(module, { named: new Set(), default: new Set() });
        }
        moduleMap.get(module)!.named.add(imports.trim());
      }
    });
  });

  return Array.from(moduleMap.entries()).map(
    ([module, { named, default: defaultImports }]) => ({
      module,
      namedImports: Array.from(named),
      defaultImports: Array.from(defaultImports),
    })
  );
};

const detectMissingImports = (
  filePath: string,
  rawCode?: string
): MissingImport[] => {
  const compilerOptions: CompilerOptions = {
    target: ScriptTarget.ESNext,
    module: ModuleKind.ESNext,
    lib: ["esnext", "dom"],
    jsx: JsxEmit.ReactJSX,
    moduleResolution: ModuleResolutionKind.Bundler,
    allowJs: true,
    allowSyntheticDefaultImports: true,
    esModuleInterop: true,
    strict: true,
    skipLibCheck: true,
    noFallthroughCasesInSwitch: true,
  };

  const servicesHost: LanguageServiceHost = {
    getScriptFileNames: () => [filePath],
    getScriptVersion: () => "0",
    getScriptSnapshot: (fileName) => {
      if (rawCode && fileName === filePath) {
        return ScriptSnapshot.fromString(rawCode);
      }
      return !sys.fileExists(fileName)
        ? undefined
        : ScriptSnapshot.fromString(sys.readFile(fileName)!);
    },
    getCurrentDirectory: () => process.cwd(),
    getCompilationSettings: () => compilerOptions,
    getDefaultLibFileName: (options) => getDefaultLibFilePath(options),
    fileExists: sys.fileExists,
    readFile: sys.readFile,
    readDirectory: sys.readDirectory,
    directoryExists: sys.directoryExists,
    getDirectories: sys.getDirectories,
    resolveModuleNames: (moduleNames, containingFile) =>
      moduleNames.map(
        (moduleName) =>
          resolveModuleName(moduleName, containingFile, compilerOptions, sys)
            .resolvedModule
      ),
  };

  const languageService = createLanguageService(
    servicesHost,
    createDocumentRegistry()
  );

  const diagnostics = languageService.getSemanticDiagnostics(filePath);

  const missingImportCodes = [
    2304, // Cannot find name 'X'
    2552, // Cannot find name 'X'. Did you mean 'Y'?
    2503, // Cannot find namespace 'X'
    2686, // 'X' refers to a UMD global, but the current file is a module
  ];

  const filteredDiagnostics = diagnostics.filter(
    (diagnostic) =>
      missingImportCodes.includes(diagnostic.code) && diagnostic.file
  );

  const processedSymbols = new Set<string>();
  const missingImports: MissingImport[] = [];

  for (const diagnostic of filteredDiagnostics) {
    const missingImport = processDiagnostic(
      diagnostic,
      filePath,
      languageService,
      processedSymbols
    );

    if (missingImport) {
      missingImports.push(missingImport);
      processedSymbols.add(missingImport.symbol);
    }
  }

  return missingImports;
};

const formatGroupedImport = (grouped: GroupedImport): string => {
  const parts: string[] = [];

  if (grouped.defaultImports.length > 0) {
    parts.push(grouped.defaultImports.join(", "));
  }

  if (grouped.namedImports.length > 0) {
    parts.push(`{ ${grouped.namedImports.join(", ")} }`);
  }

  return `import ${parts.join(", ")} from "${grouped.module}";`;
};

const analyzeFile = (filePath: string, rawCode?: string): void => {
  const displayName = rawCode ? "raw code" : basename(filePath);
  console.log(`\nAnalyzing: ${displayName}\n`);

  const missingImports = detectMissingImports(filePath, rawCode);

  if (missingImports.length === 0) {
    console.log("[TS] No missing imports detected!");
    return;
  }

  missingImports.forEach(({ symbol, suggestedImports }) => {
    if (suggestedImports.length === 0) return;

    if (suggestedImports.length === 1) {
      console.log(
        `[TS] ${symbol} import suggestion:\n   ${suggestedImports[0]}`
      );
      console.log();
      return;
    }

    console.log(`[TS] ${symbol} import suggestions:`);
    suggestedImports.forEach((suggestion) => {
      console.log(`   ${suggestion}`);
    });
  });

  const groupedImports = groupImportsByModule(missingImports);
  if (groupedImports.length > 0) {
    console.log(`[TS] Grouped suggestions:`);
    groupedImports.forEach((grouped) => {
      console.log(`   ${formatGroupedImport(grouped)}`);
    });
  }
};

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    code: {
      type: "string",
      short: "c",
      description: "Analyze raw TypeScript/JavaScript code directly",
    },
    help: {
      type: "boolean",
      short: "h",
      description: "Show help message",
    },
  },
  allowPositionals: true,
});

if (values.help) {
  console.log(`
Usage: auto-import [options] [file]

Options:
  -c, --code <code>    Analyze raw TypeScript/JavaScript code
  -h, --help           Show this help message

Examples:
  auto-import src/app.ts
  auto-import --code "const x = React.useState()"
  auto-import -c "import { motion } from 'motion'"
`);
  process.exit(0);
}

if (values.code) {
  const tempFilePath = resolve(process.cwd(), "temp.ts");
  analyzeFile(tempFilePath, values.code);
} else if (positionals[0]) {
  const filePath = resolve(positionals[0]);
  analyzeFile(filePath);
} else {
  console.error("[ERROR]: Please provide a file path or use --code option");
  console.log("Use --help for usage information");
  process.exit(1);
}
