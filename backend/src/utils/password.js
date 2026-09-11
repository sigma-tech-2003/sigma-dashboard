import argon2 from "argon2";

/**
 * argon2id, not bcrypt.
 *
 * argon2id won the Password Hashing Competition and is OWASP's first recommendation. It
 * is memory-hard: an attacker must commit ~19 MiB per guess, which is what blunts GPU and
 * ASIC cracking. bcrypt's working set is 4 KB, so a GPU can run enormous numbers of
 * candidates in parallel against it.
 *
 * bcrypt's advantages are maturity and the fact that its silent truncation at 72 bytes is
 * well understood. Neither outweighs memory-hardness here: this is a greenfield schema,
 * users.password_hash is already `text`, and there are no existing hashes to migrate.
 *
 * Parameters follow the OWASP Password Storage Cheat Sheet for argon2id.
 */
const HASH_OPTIONS = Object.freeze({
  type: argon2.argon2id,
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
});

export async function hashPassword(plainPassword) {
  if (typeof plainPassword !== "string" || plainPassword.length === 0) {
    throw new TypeError("A password is required.");
  }
  return argon2.hash(plainPassword, HASH_OPTIONS);
}

/**
 * Returns false rather than throwing for a malformed or absent stored hash. A user row
 * with password_hash NULL is an invited account that has not set a password yet
 * (users.status = 'invited'); it must fail verification, not crash the login route.
 */
export async function verifyPassword(storedHash, plainPassword) {
  if (typeof storedHash !== "string" || storedHash.length === 0) return false;
  if (typeof plainPassword !== "string" || plainPassword.length === 0) return false;

  try {
    return await argon2.verify(storedHash, plainPassword);
  } catch {
    return false;
  }
}

export const passwordHashOptions = HASH_OPTIONS;
