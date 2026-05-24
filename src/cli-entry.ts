#!/usr/bin/env node
// Unified Manamir entry point.
//
// Dispatches between:
//   manamir init [flags]   → run the onboarding wizard
//   manamir cli            → local REPL (alias for `npm run cli`)
//   manamir start          → boot the full bot (Discord + WS)
//   manamir help           → usage
//
// Mounted as `bin.manamir` in package.json after build (`tsc -p .`).
// During development, run via `tsx src/cli-entry.ts <subcommand>`.

import { resolve } from 'path';
import type { ProviderId, WizardFlags } from './cli/init-wizard.js';

type Subcommand = 'init' | 'cli' | 'start' | 'help' | 'version';

interface ParsedArgs {
  subcommand: Subcommand;
  flags: WizardFlags;
  configPath: string;
  force: boolean;
  dryRun: boolean;
}

function printHelp(): void {
  process.stdout.write(
    [
      'Manamir — multi-channel AI agent harness',
      '',
      'Usage: manamir <command> [options]',
      '',
      'Commands:',
      '  init                 Interactive setup wizard (writes .env)',
      '  cli                  Start the local REPL channel',
      '  start                Start the full bot (Discord + WS)',
      '  help                 Show this help',
      '  version              Print version',
      '',
      'Init flags:',
      '  --provider=<id>      deepseek | claude | openai | custom',
      '  --api-key=<key>      Provider API key',
      '  --base-url=<url>     Custom base URL (only with --provider=custom)',
      '  --model=<name>       Model name override',
      '  --no-discord         Skip Discord setup',
      '  --discord-token=<t>  Discord bot token',
      '  --discord-client-id=<id>',
      '  --allowed-user-ids=<csv>',
      '  --profile=<name>     Profile name (default: "default")',
      '  --config=<path>      Where to write .env (default: ./.env)',
      '  --force              Overwrite existing .env',
      '  --dry-run            Print what would be written, don\'t write',
      '  --yes                Skip confirmation prompt',
      '',
      'Examples:',
      '  manamir init',
      '  manamir init --provider=deepseek --api-key=sk-... --no-discord --yes',
      '  manamir init --force',
      '  manamir cli',
      '',
      'Docs: https://github.com/your-org/manamir',
      '',
    ].join('\n')
  );
}

function isProviderId(v: string): v is ProviderId {
  return v === 'deepseek' || v === 'claude' || v === 'openai' || v === 'custom';
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  if (args.length === 0) {
    return { subcommand: 'help', flags: {}, configPath: './.env', force: false, dryRun: false };
  }

  const sub = args[0];
  let subcommand: Subcommand;
  switch (sub) {
    case 'init':
    case 'cli':
    case 'start':
    case 'help':
    case 'version':
    case '--help':
    case '-h':
      subcommand = sub === '--help' || sub === '-h' ? 'help' : (sub as Subcommand);
      break;
    default:
      process.stderr.write(`Unknown command: ${sub}\n\n`);
      printHelp();
      process.exit(2);
  }

  const flags: WizardFlags = {};
  let configPath = './.env';
  let force = false;
  let dryRun = false;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--no-discord') { flags.noDiscord = true; continue; }
    if (arg === '--force') { force = true; continue; }
    if (arg === '--dry-run') { dryRun = true; continue; }
    if (arg === '--yes' || arg === '-y') { flags.yes = true; continue; }

    const eq = arg.indexOf('=');
    if (eq < 0 || !arg.startsWith('--')) {
      process.stderr.write(`Unknown or malformed flag: ${arg}\n`);
      process.exit(2);
    }
    const key = arg.slice(2, eq);
    const val = arg.slice(eq + 1);
    switch (key) {
      case 'provider':
        if (!isProviderId(val)) {
          process.stderr.write(`Invalid provider: ${val} (deepseek|claude|openai|custom)\n`);
          process.exit(2);
        }
        flags.provider = val;
        break;
      case 'api-key': flags.apiKey = val; break;
      case 'base-url': flags.baseUrl = val; break;
      case 'model': flags.model = val; break;
      case 'discord-token': flags.discordToken = val; break;
      case 'discord-client-id': flags.discordClientId = val; break;
      case 'allowed-user-ids':
        flags.allowedUserIds = val.split(',').map((s) => s.trim()).filter(Boolean);
        break;
      case 'profile': flags.profileName = val; break;
      case 'config': configPath = val; break;
      default:
        process.stderr.write(`Unknown flag: --${key}\n`);
        process.exit(2);
    }
  }

  return { subcommand, flags, configPath, force, dryRun };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv);

  switch (parsed.subcommand) {
    case 'help':
      printHelp();
      return;
    case 'version': {
      // Lazy read of package.json so this never crashes the binary.
      // Try a few candidate locations so this works whether we're running
      // from src/ via tsx or from dist/ via the built bin.
      try {
        const fs = await import('fs/promises');
        const { fileURLToPath } = await import('url');
        const here = fileURLToPath(import.meta.url);
        const candidates = [
          resolve(here, '..', '..', 'package.json'),       // src/cli-entry.ts → ./package.json
          resolve(here, '..', '..', '..', 'package.json'), // dist/cli-entry.js → ./package.json
          resolve(process.cwd(), 'package.json'),
        ];
        let printed = false;
        for (const pkgPath of candidates) {
          try {
            const text = await fs.readFile(pkgPath, 'utf8');
            const pkg = JSON.parse(text) as { version?: string };
            if (pkg.version) {
              process.stdout.write(`${pkg.version}\n`);
              printed = true;
              break;
            }
          } catch {
            // try next
          }
        }
        if (!printed) process.stdout.write('unknown\n');
      } catch {
        process.stdout.write('unknown\n');
      }
      return;
    }
    case 'init': {
      const { runInitWizard } = await import('./cli/init-wizard.js');
      try {
        await runInitWizard({
          configPath: parsed.configPath,
          force: parsed.force,
          flags: parsed.flags,
          dryRun: parsed.dryRun,
        });
      } catch (err) {
        process.stderr.write(`\ninit failed: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
      return;
    }
    case 'cli': {
      // Boots the existing CLI entry. The cli module runs main() at import,
      // so we just import it and let it take over.
      await import('./cli.js');
      return;
    }
    case 'start': {
      await import('./index.js');
      return;
    }
    default: {
      // Exhaustiveness — TS will scream if we miss a case.
      const _exhaustive: never = parsed.subcommand;
      throw new Error(`Unhandled subcommand: ${String(_exhaustive)}`);
    }
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
