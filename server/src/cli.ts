/**
 * Hub command line (run as the hub's system user):
 *   node server/src/main.ts setup-code              prints a one-time setup code and the dashboard URL
 *   node server/src/main.ts setup-code --code <c>   registers a setup code made elsewhere (stores only its hash)
 *   node server/src/main.ts reset-totp <username>   clears a user's 2-step so they enroll again at next sign-in
 *   node server/src/main.ts list-users              lists accounts
 */

import { createAuditWriter } from './audit.ts';
import { getUserByName, ownerExists } from './auth/accounts.ts';
import type { UserRow } from './auth/accounts.ts';
import { deleteUserChallenges } from './auth/challenges.ts';
import { deleteUserSessions } from './auth/sessions.ts';
import { createSetupCode, isSetupCodeShape, registerSetupCode } from './auth/setup-codes.ts';
import { loadConfig } from './config.ts';
import type { HubConfig } from './contracts.ts';
import { dbFile, openDatabase, transaction } from './db.ts';

export interface CliIo {
  env?: NodeJS.ProcessEnv;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

const USAGE = [
  'Usage: node server/src/main.ts [command]',
  '',
  '  (no command)            run the hub',
  '  setup-code              print a one-time setup code for creating the owner account',
  '  setup-code --code <c>   register a setup code made elsewhere instead (base32, 26 to 64 characters)',
  '  reset-totp <username>   clear a user\'s 2-step code so they set it up again at next sign-in',
  '  list-users              list accounts',
];

export const CLI_COMMANDS = ['setup-code', 'reset-totp', 'list-users', 'help', '--help', '-h'];

export async function runCli(args: string[], io: CliIo = {}): Promise<number> {
  const out = io.out ?? ((line: string) => process.stdout.write(line + '\n'));
  const err = io.err ?? ((line: string) => process.stderr.write(line + '\n'));
  const [command, ...rest] = args;

  if (command === 'help' || command === '--help' || command === '-h') {
    USAGE.forEach((l) => out(l));
    return 0;
  }
  if (!CLI_COMMANDS.includes(command)) {
    err(`Unknown command: ${command}`);
    USAGE.forEach((l) => err(l));
    return 1;
  }

  let given: string | undefined;
  if (command === 'setup-code' && rest.length > 0) {
    const value = rest[0] === '--code' ? rest[1] : rest[0]?.startsWith('--code=') ? rest[0].slice('--code='.length) : undefined;
    const extra = rest[0] === '--code' ? rest.slice(2) : rest.slice(1);
    if (value === undefined || extra.length > 0) {
      err('Usage: setup-code [--code <code>]');
      return 1;
    }
    if (!isSetupCodeShape(value)) {
      err('The setup code must be base32 (letters A-Z and digits 2-7), 26 to 64 characters.');
      return 1;
    }
    given = value;
  }

  let config: HubConfig;
  try {
    config = loadConfig(io.env ?? process.env);
  } catch (e) {
    err((e as Error).message);
    return 1;
  }
  const db = openDatabase(dbFile(config.dataDir));
  try {
    if (command === 'setup-code') {
      if (ownerExists(db)) {
        out(`An owner account already exists. Sign in at ${config.publicOrigin}/login`);
        return 0;
      }
      if (given !== undefined) {
        if (!registerSetupCode(db, given, Date.now())) {
          err('That setup code was already used. Make a new one.');
          return 1;
        }
        // The code itself is never printed: whoever made it already has it.
        out(`Setup code registered. Open ${config.publicOrigin}/setup and enter it within 30 days. It works once.`);
        return 0;
      }
      const code = createSetupCode(db, Date.now());
      out(`Setup code: ${code}`);
      out(`Open ${config.publicOrigin}/setup and enter this code within 24 hours. It works once.`);
      return 0;
    }

    if (command === 'reset-totp') {
      const username = rest[0];
      if (!username) {
        err('Usage: reset-totp <username>');
        return 1;
      }
      const user = getUserByName(db, username);
      if (!user) {
        err(`No account named "${username}"`);
        return 1;
      }
      transaction(db, () => {
        db.prepare(
          'UPDATE users SET totp_secret_enc = NULL, totp_enabled = 0, totp_last_step = 0, failed_count = 0, first_failed_at = 0, locked_until = 0 WHERE id = ?',
        ).run(user.id);
        deleteUserSessions(db, user.id);
        deleteUserChallenges(db, user.id);
      });
      createAuditWriter(db)({
        userId: null,
        action: 'account.totp_reset',
        target: `user:${user.id}`,
        detail: `2-step cleared for ${user.username} from the hub command line`,
      });
      out(`2-step cleared for ${user.username}. They set it up again at their next sign-in; their devices were signed out.`);
      return 0;
    }

    // list-users
    const rows = db.prepare("SELECT * FROM users ORDER BY role = 'owner' DESC, username COLLATE NOCASE").all() as unknown as UserRow[];
    if (rows.length === 0) {
      out('No accounts yet. Run "setup-code" to create the owner account.');
      return 0;
    }
    const now = Date.now();
    out(['id', 'username', 'role', '2-step', 'status'].join('\t'));
    for (const r of rows) {
      const status = r.disabled === 1 ? 'disabled' : r.locked_until > now ? `locked until ${new Date(r.locked_until).toISOString()}` : 'active';
      out([r.id, r.username, r.role, r.totp_enabled === 1 ? 'on' : 'not set up', status].join('\t'));
    }
    return 0;
  } finally {
    db.close();
  }
}
