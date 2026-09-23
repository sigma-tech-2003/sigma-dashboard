/**
 * Creates the very first admin in an empty database: one companies row, one department, one
 * admin user, and their employee row. Refuses if any companies or users row already exists.
 * Requires --confirm-database like every other write script in this repo.
 *
 *   node scripts/bootstrap-admin.js --email=admin@example.com --confirm-database=sigma_hrm_scratch
 *
 * Optional: --company-name= (default "Sigma"), --company-code= (default "SIGMA"),
 * --department-name= (default "Administration"), --full-name= (default "System
 * Administrator"), --position-title= (default "Administrator").
 *
 * The password is never a required flag. Omit --password= and the script prompts twice,
 * without echoing input. --password=<value> is accepted for scripted/CI use, but appears in
 * shell history and process listings -- prefer the interactive prompt for a real account.
 */

import { pathToFileURL } from "node:url";
import { closePool, getPool } from "../src/db/pool.js";
import { createBootstrapRepository } from "../src/repositories/bootstrapRepository.js";
import { hashPassword } from "../src/utils/password.js";

function parseArgs(argv) {
  const flags = {};
  for (const argument of argv) {
    if (argument.startsWith("--email=")) flags.email = argument.slice("--email=".length);
    else if (argument.startsWith("--password=")) flags.password = argument.slice("--password=".length);
    else if (argument.startsWith("--confirm-database=")) flags.confirmDatabase = argument.slice("--confirm-database=".length);
    else if (argument.startsWith("--company-name=")) flags.companyName = argument.slice("--company-name=".length);
    else if (argument.startsWith("--company-code=")) flags.companyCode = argument.slice("--company-code=".length);
    else if (argument.startsWith("--department-name=")) flags.departmentName = argument.slice("--department-name=".length);
    else if (argument.startsWith("--full-name=")) flags.fullName = argument.slice("--full-name=".length);
    else if (argument.startsWith("--position-title=")) flags.positionTitle = argument.slice("--position-title=".length);
  }
  return flags;
}

/**
 * Reads one line from stdin without echoing it back, so a password never appears on screen.
 * Streams are injectable so tests can supply fakes instead of the real process.stdin/stdout.
 *
 * Chunks are processed character by character, not as a single unit: a typed keystroke
 * usually arrives as its own one-character chunk, but a pasted or piped value arrives as one
 * chunk containing the whole string, e.g. "secret\r". Comparing that entire chunk against
 * "\r" never matches, so Enter would never be detected and the trailing \r would end up
 * stored as part of the password. Looping over every character in the chunk and stopping as
 * soon as Enter or Ctrl+C is seen -- even mid-chunk -- avoids both problems.
 */
export function promptHidden(promptText, { stdin = process.stdin, stdout = process.stdout } = {}) {
  return new Promise((resolve, reject) => {
    stdout.write(promptText);
    const wasRaw = stdin.isTTY ? stdin.isRaw : false;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let input = "";
    const cleanup = () => {
      stdin.removeListener("data", onData);
      if (stdin.isTTY) stdin.setRawMode(wasRaw);
      stdin.pause();
    };
    const onData = (chunk) => {
      const text = chunk.toString("utf8");
      for (const char of text) {
        if (char === "\n" || char === "\r" || char === "\x04") { // Enter / EOF
          cleanup();
          stdout.write("\n");
          resolve(input);
          return;
        }
        if (char === "\x03") { // Ctrl+C
          cleanup();
          stdout.write("\n");
          reject(new Error("Aborted."));
          return;
        }
        if (char === "\x7f" || char === "\b") { // Backspace / DEL
          input = input.slice(0, -1);
        } else {
          input += char;
        }
      }
    };
    stdin.on("data", onData);
  });
}

export async function promptPassword() {
  const first = await promptHidden("Password: ");
  if (first.length === 0) throw new Error("Password must not be empty.");
  const second = await promptHidden("Confirm password: ");
  if (first !== second) throw new Error("Passwords did not match.");
  return first;
}

// Guards the CLI body so importing this module (e.g. from a test, to reach promptHidden/
// promptPassword) never runs it -- the same pattern src/db/migrator.js already uses.
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const flags = parseArgs(process.argv.slice(2));

  if (!flags.email) {
    console.error(
      "Usage: node scripts/bootstrap-admin.js --email=<email> --confirm-database=<name> "
      + "[--password=<value>] [--company-name=] [--company-code=] [--department-name=] "
      + "[--full-name=] [--position-title=]",
    );
    process.exitCode = 1;
  } else if (process.env.NODE_ENV === "production") {
    console.error("Refusing to bootstrap with NODE_ENV=production.");
    process.exitCode = 1;
  } else {
    try {
      const pool = getPool();
      const { rows: [{ current_database: currentDatabase }] } = await pool.query("SELECT current_database()");
      if (!flags.confirmDatabase) {
        throw new Error(`Refusing to bootstrap: pass --confirm-database=${currentDatabase} to confirm the target.`);
      }
      if (flags.confirmDatabase !== currentDatabase) {
        throw new Error(`Refusing to bootstrap: connected to "${currentDatabase}" but "${flags.confirmDatabase}" was confirmed.`);
      }

      const password = flags.password ?? await promptPassword();
      const passwordHash = await hashPassword(password);

      const repository = createBootstrapRepository(pool);
      const result = await repository.createFirstAdmin({
        email: flags.email.trim(),
        passwordHash,
        companyName: flags.companyName?.trim() || "Sigma",
        companyCode: flags.companyCode?.trim() || "SIGMA",
        departmentName: flags.departmentName?.trim() || "Administration",
        fullName: flags.fullName?.trim() || "System Administrator",
        positionTitle: flags.positionTitle?.trim() || "Administrator",
      });

      console.info(`\nCreated the first admin in "${currentDatabase}":`);
      console.info(`  company:    ${result.companyId}`);
      console.info(`  department: ${result.departmentId}`);
      console.info(`  user:       ${result.userId} (${flags.email.trim()})`);
      console.info(`  employee:   ${result.employeeId} (${result.employeeNumber})`);
      console.info("\nLog in at POST /api/v1/auth/login with this email and the password you entered.");
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    } finally {
      await closePool();
    }
  }
}
