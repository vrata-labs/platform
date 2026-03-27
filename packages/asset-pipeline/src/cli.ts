import { validateAsset } from "./validator.js";

interface CliArgs {
  fileName: string;
  extension: string;
  sizeMb: number;
}

function parseArgs(argv: string[]): CliArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    values.set(argv[index] ?? "", argv[index + 1] ?? "");
  }

  const fileName = values.get("--file") ?? "";
  const extension = values.get("--ext") ?? "";
  const sizeMb = Number.parseFloat(values.get("--size-mb") ?? "0");

  return { fileName, extension, sizeMb };
}

const args = parseArgs(process.argv.slice(2));
const result = validateAsset(args);

process.stdout.write(`${JSON.stringify(result)}\n`);
if (!result.ok) {
  process.exitCode = 1;
}
